/**
 * Owner login route: receives the password form post from the page rendered
 * by OwnerAuthorizationProvider.authorize(), verifies it against the bcrypt
 * hash from config, and redirects back to the client with an authorization
 * code on success.
 */
import bcrypt from 'bcryptjs';
import express, {Request, Response, Router} from 'express';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';

import {AuditEvent, AuthRoutePath, RATE_LIMIT} from '../constants.js';
import {logger} from '../logger.js';
import {LoginField, renderErrorPage, renderLoginPage} from './loginPage.js';
import {OwnerAuthorizationProvider} from './provider.js';

const loginBodySchema = z.object({
  [LoginField.PendingId]: z.string().min(1),
  [LoginField.Password]: z.string().min(1),
});

const OAUTH_QUERY_PARAM_CODE = 'code';
const OAUTH_QUERY_PARAM_STATE = 'state';

export function createLoginRouter(
  provider: OwnerAuthorizationProvider,
  ownerPasswordHash: string,
): Router {
  const router = express.Router();

  const loginRateLimit = rateLimit({
    windowMs: RATE_LIMIT.login.windowMs,
    limit: RATE_LIMIT.login.limit,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post(
    AuthRoutePath.Login,
    loginRateLimit,
    express.urlencoded({extended: false}),
    async (req: Request, res: Response) => {
      const parsed = loginBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .type('html')
          .send(renderErrorPage('Malformed login request.'));
        return;
      }
      const pendingId = parsed.data[LoginField.PendingId];
      const password = parsed.data[LoginField.Password];

      const passwordOk = await bcrypt.compare(password, ownerPasswordHash);
      if (!passwordOk) {
        logger.info('audit', {event: AuditEvent.LoginFailure, ip: req.ip});
        res
          .status(401)
          .type('html')
          .send(
            renderLoginPage({
              pendingId,
              errorMessage: 'Incorrect password.',
            }),
          );
        return;
      }

      const issued = provider.issueAuthorizationCode(pendingId);
      if (issued === undefined) {
        // Expired or replayed pending id; make the user restart the flow.
        res
          .status(400)
          .type('html')
          .send(
            renderErrorPage(
              'This sign-in link has expired. Return to the client and connect again.',
            ),
          );
        return;
      }

      logger.info('audit', {event: AuditEvent.LoginSuccess, ip: req.ip});
      const target = new URL(issued.redirectUri);
      target.searchParams.set(OAUTH_QUERY_PARAM_CODE, issued.code);
      if (issued.state !== undefined) {
        target.searchParams.set(OAUTH_QUERY_PARAM_STATE, issued.state);
      }
      res.redirect(target.href);
    },
  );

  return router;
}
