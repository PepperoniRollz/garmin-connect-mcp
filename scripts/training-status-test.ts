/**
 * Synthetic unit acceptance for the training-status transform (pure, no
 * Garmin account). Feeds hand-built aggregated-DTO fixtures through
 * transformTrainingStatus() and asserts DTO extraction, device picking,
 * the NO_STATUS "warming up" path, VO2max/load-balance shaping, and the
 * empty (pre-965 / no-data) case.
 *
 *   npx tsx scripts/training-status-test.ts
 */
import {transformTrainingStatus} from '../src/trainingStatus.js';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures += 1;
}

// --- Fixture 1: full payload mirroring the live 965 shape (status warming) ---
const full = {
  userId: 1,
  mostRecentVO2Max: {
    generic: {
      calendarDate: '2026-05-26',
      vo2MaxPreciseValue: 33.8,
      vo2MaxValue: 34,
      fitnessAge: 65,
    },
    cycling: null,
  },
  mostRecentTrainingLoadBalance: {
    metricsTrainingLoadBalanceDTOMap: {
      '3629056397': {
        calendarDate: '2026-06-14',
        deviceId: 3629056397,
        monthlyLoadAerobicLow: 277.5791,
        monthlyLoadAerobicHigh: 242.0587,
        monthlyLoadAnaerobic: 7.780121,
        monthlyLoadAerobicLowTargetMin: 95,
        monthlyLoadAerobicLowTargetMax: 260,
        monthlyLoadAerobicHighTargetMin: 205,
        monthlyLoadAerobicHighTargetMax: 369,
        monthlyLoadAnaerobicTargetMin: 0,
        monthlyLoadAnaerobicTargetMax: 164,
        trainingBalanceFeedbackPhrase: 'AEROBIC_LOW_FOCUS',
        primaryTrainingDevice: true,
      },
    },
    recordedDevices: [{deviceId: 3629056397, deviceName: 'Forerunner 965'}],
  },
  mostRecentTrainingStatus: {
    latestTrainingStatusData: {
      '3629056397': {
        calendarDate: '2026-06-14',
        sinceDate: '2026-06-08',
        trainingStatus: 0,
        trainingStatusFeedbackPhrase: 'NO_STATUS_2',
        fitnessTrend: 0,
        fitnessTrendSport: 'NONE',
        trainingPaused: false,
        acuteTrainingLoadDTO: {
          acwrPercent: 66,
          acwrStatus: 'HIGH',
          acwrStatusFeedback: 'FEEDBACK_4',
          dailyTrainingLoadAcute: 166,
          dailyTrainingLoadChronic: 110,
          maxTrainingLoadChronic: 165,
          minTrainingLoadChronic: 88,
          dailyAcuteChronicWorkloadRatio: 1.5,
        },
        primaryTrainingDevice: true,
      },
    },
    recordedDevices: [{deviceId: 3629056397, deviceName: 'Forerunner 965'}],
  },
};

const s = transformTrainingStatus(full, '2026-06-14');

check('full payload is marked available', s.available === true);
check(
  'device identified from recordedDevices',
  s.device?.deviceName === 'Forerunner 965' &&
    s.device?.deviceId === 3629056397,
  JSON.stringify(s.device),
);

// Training status + warming-up handling
check(
  'NO_STATUS code flagged as warming up, not an error',
  s.trainingStatus?.warming === true &&
    typeof s.trainingStatus?.note === 'string' &&
    s.trainingStatus?.feedbackPhrase === 'NO_STATUS_2',
  JSON.stringify(s.trainingStatus),
);
check(
  'training status carries since/fitness trend',
  s.trainingStatus?.sinceDate === '2026-06-08' &&
    s.trainingStatus?.fitnessTrendSport === 'NONE',
);

// Acute/chronic load + ACWR
check(
  'acute/chronic load + ACWR extracted',
  s.load?.acuteLoad === 166 &&
    s.load?.chronicLoad === 110 &&
    s.load?.acwr === 1.5 &&
    s.load?.acwrPercent === 66 &&
    s.load?.acwrStatus === 'HIGH',
  JSON.stringify(s.load),
);
check(
  'chronic load range extracted',
  s.load?.chronicLoadRange?.min === 88 && s.load?.chronicLoadRange?.max === 165,
);

// VO2max
check(
  'vo2max precise + rounded + fitness age + date',
  s.vo2max?.precise === 33.8 &&
    s.vo2max?.value === 34 &&
    s.vo2max?.fitnessAge === 65 &&
    s.vo2max?.calendarDate === '2026-05-26',
  JSON.stringify(s.vo2max),
);

// Load balance
check(
  'load balance loads + targets + feedback extracted',
  s.loadBalance?.aerobicLow === 277.5791 &&
    s.loadBalance?.aerobicHighTarget?.max === 369 &&
    s.loadBalance?.anaerobicTarget?.min === 0 &&
    s.loadBalance?.feedbackPhrase === 'AEROBIC_LOW_FOCUS',
  JSON.stringify(s.loadBalance),
);

// --- Fixture 2: established status (not warming) ---
const established = {
  mostRecentTrainingStatus: {
    latestTrainingStatusData: {
      '111': {
        calendarDate: '2026-07-01',
        trainingStatus: 3,
        trainingStatusFeedbackPhrase: 'PRODUCTIVE_1',
        fitnessTrend: 1,
        primaryTrainingDevice: true,
        acuteTrainingLoadDTO: {
          dailyTrainingLoadAcute: 300,
          dailyTrainingLoadChronic: 280,
          dailyAcuteChronicWorkloadRatio: 1.07,
          acwrPercent: 80,
          acwrStatus: 'OPTIMAL',
        },
      },
    },
    recordedDevices: [{deviceId: 111, deviceName: 'Forerunner 965'}],
  },
};
const e = transformTrainingStatus(established, '2026-07-01');
check(
  'established status not flagged warming',
  e.trainingStatus?.warming === false &&
    e.trainingStatus?.feedbackPhrase === 'PRODUCTIVE_1',
  JSON.stringify(e.trainingStatus),
);

// --- Fixture 3: empty (pre-965 date returns []) ---
const empty = transformTrainingStatus([], '2026-06-01');
check(
  'empty array → not available, no throw',
  empty.available === false && typeof empty.message === 'string',
  JSON.stringify(empty),
);
const emptyObj = transformTrainingStatus(
  {mostRecentTrainingStatus: {latestTrainingStatusData: {}}},
  '2026-06-01',
);
check(
  'object with empty DTO maps → not available',
  emptyObj.available === false,
  JSON.stringify(emptyObj),
);

// --- Fixture 4: partial — status present, vo2max/loadBalance absent ---
const partial = transformTrainingStatus(
  {
    mostRecentTrainingStatus: {
      latestTrainingStatusData: {
        '5': {
          calendarDate: '2026-06-14',
          trainingStatus: 0,
          trainingStatusFeedbackPhrase: 'NO_STATUS_2',
          primaryTrainingDevice: true,
        },
      },
    },
  },
  '2026-06-14',
);
check(
  'partial payload available with null vo2max/loadBalance',
  partial.available === true &&
    partial.vo2max === null &&
    partial.loadBalance === null,
  JSON.stringify({v: partial.vo2max, lb: partial.loadBalance}),
);

// --- Fixture 5: device picking prefers primaryTrainingDevice ---
const multi = transformTrainingStatus(
  {
    mostRecentTrainingStatus: {
      latestTrainingStatusData: {
        '900': {
          calendarDate: '2026-06-10',
          trainingStatus: 2,
          trainingStatusFeedbackPhrase: 'MAINTAINING_1',
          primaryTrainingDevice: false,
        },
        '901': {
          calendarDate: '2026-06-14',
          trainingStatus: 3,
          trainingStatusFeedbackPhrase: 'PRODUCTIVE_1',
          primaryTrainingDevice: true,
        },
      },
      recordedDevices: [
        {deviceId: 900, deviceName: 'Old Watch'},
        {deviceId: 901, deviceName: 'Forerunner 965'},
      ],
    },
  },
  '2026-06-14',
);
check(
  'picks the primaryTrainingDevice entry',
  multi.trainingStatus?.feedbackPhrase === 'PRODUCTIVE_1' &&
    multi.device?.deviceName === 'Forerunner 965',
  JSON.stringify({ts: multi.trainingStatus?.feedbackPhrase, d: multi.device}),
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
