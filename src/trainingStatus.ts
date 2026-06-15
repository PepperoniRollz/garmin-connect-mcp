/**
 * Pure transform from Garmin's aggregated training-status payload
 * (/metrics-service/metrics/trainingstatus/aggregated/{date}) into a clean,
 * coaching-useful summary. The raw payload nests three DTOs — training
 * status, training-load balance, and VO2max — each keyed by deviceId; this
 * picks the primary device, flattens the over/under-training signals
 * (acute/chronic load + ACWR), and handles the NO_STATUS "warming up" and
 * empty (pre-965 / unsupported) cases gracefully. No Garmin client here, so
 * it stays unit-testable without an account.
 */

/** A device's training-status record (one per deviceId in the raw map). */
interface RawStatusEntry {
  calendarDate?: string;
  sinceDate?: string;
  trainingStatus?: number;
  trainingStatusFeedbackPhrase?: string;
  fitnessTrend?: number;
  fitnessTrendSport?: string;
  trainingPaused?: boolean;
  primaryTrainingDevice?: boolean;
  acuteTrainingLoadDTO?: {
    acwrPercent?: number;
    acwrStatus?: string;
    acwrStatusFeedback?: string;
    dailyTrainingLoadAcute?: number;
    dailyTrainingLoadChronic?: number;
    maxTrainingLoadChronic?: number;
    minTrainingLoadChronic?: number;
    dailyAcuteChronicWorkloadRatio?: number;
  };
}

interface RawLoadBalanceEntry {
  calendarDate?: string;
  monthlyLoadAerobicLow?: number;
  monthlyLoadAerobicHigh?: number;
  monthlyLoadAnaerobic?: number;
  monthlyLoadAerobicLowTargetMin?: number;
  monthlyLoadAerobicLowTargetMax?: number;
  monthlyLoadAerobicHighTargetMin?: number;
  monthlyLoadAerobicHighTargetMax?: number;
  monthlyLoadAnaerobicTargetMin?: number;
  monthlyLoadAnaerobicTargetMax?: number;
  trainingBalanceFeedbackPhrase?: string;
  primaryTrainingDevice?: boolean;
}

interface RawDevice {
  deviceId?: number;
  deviceName?: string;
}

interface RawAggregated {
  mostRecentVO2Max?: {
    generic?: {
      calendarDate?: string;
      vo2MaxPreciseValue?: number;
      vo2MaxValue?: number;
      fitnessAge?: number;
    } | null;
  } | null;
  mostRecentTrainingLoadBalance?: {
    metricsTrainingLoadBalanceDTOMap?: Record<string, RawLoadBalanceEntry>;
    recordedDevices?: RawDevice[];
  } | null;
  mostRecentTrainingStatus?: {
    latestTrainingStatusData?: Record<string, RawStatusEntry>;
    recordedDevices?: RawDevice[];
  } | null;
}

export interface TrainingStatusSummary {
  date: string;
  available: boolean;
  message?: string;
  device: {deviceId: number | null; deviceName: string | null} | null;
  trainingStatus: {
    statusCode: number | null;
    feedbackPhrase: string | null;
    fitnessTrend: number | null;
    fitnessTrendSport: string | null;
    calendarDate: string | null;
    sinceDate: string | null;
    trainingPaused: boolean | null;
    /** True when the device hasn't established a status yet (NO_STATUS). */
    warming: boolean;
    note?: string;
  } | null;
  load: {
    acuteLoad: number | null;
    chronicLoad: number | null;
    acwr: number | null;
    acwrPercent: number | null;
    acwrStatus: string | null;
    acwrStatusFeedback: string | null;
    chronicLoadRange: {min: number | null; max: number | null};
  } | null;
  vo2max: {
    precise: number | null;
    value: number | null;
    fitnessAge: number | null;
    calendarDate: string | null;
  } | null;
  loadBalance: {
    aerobicLow: number | null;
    aerobicHigh: number | null;
    anaerobic: number | null;
    aerobicLowTarget: {min: number | null; max: number | null};
    aerobicHighTarget: {min: number | null; max: number | null};
    anaerobicTarget: {min: number | null; max: number | null};
    feedbackPhrase: string | null;
    calendarDate: string | null;
  } | null;
}

/**
 * From a deviceId-keyed map, pick the primary training device; otherwise the
 * entry with the latest calendarDate; otherwise the first. Returns the entry
 * and its deviceId key.
 */
function pickPrimary<
  T extends {primaryTrainingDevice?: boolean; calendarDate?: string},
>(map: Record<string, T> | undefined): {key: string; entry: T} | null {
  if (!map) return null;
  const entries = Object.entries(map);
  if (entries.length === 0) return null;
  const primary = entries.find(([, v]) => v.primaryTrainingDevice === true);
  if (primary) return {key: primary[0], entry: primary[1]};
  const sorted = entries
    .slice()
    .sort(([, a], [, b]) =>
      (b.calendarDate ?? '').localeCompare(a.calendarDate ?? ''),
    );
  return {key: sorted[0][0], entry: sorted[0][1]};
}

/** A NO_STATUS code (0) or NO_STATUS_* feedback phrase means "warming up". */
function isWarming(
  statusCode: number | undefined,
  phrase: string | undefined,
): boolean {
  if (statusCode === undefined || statusCode === null || statusCode === 0)
    return true;
  return (phrase ?? '').startsWith('NO_STATUS');
}

function findDeviceName(
  devices: RawDevice[] | undefined,
  deviceId: number | null,
): string | null {
  if (!devices || deviceId === null) return null;
  return devices.find(d => d.deviceId === deviceId)?.deviceName ?? null;
}

export function transformTrainingStatus(
  raw: unknown,
  date: string,
): TrainingStatusSummary {
  const notAvailable = (): TrainingStatusSummary => ({
    date,
    available: false,
    message: `Training status isn't available for ${date}. It's a Forerunner 965-class metric; pre-upgrade dates and unsupported devices return no records.`,
    device: null,
    trainingStatus: null,
    load: null,
    vo2max: null,
    loadBalance: null,
  });

  // Pre-965 dates / unsupported devices come back as [] or null.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return notAvailable();
  }
  const agg = raw as RawAggregated;

  const statusPick = pickPrimary(
    agg.mostRecentTrainingStatus?.latestTrainingStatusData,
  );
  const balancePick = pickPrimary(
    agg.mostRecentTrainingLoadBalance?.metricsTrainingLoadBalanceDTOMap,
  );
  const vo2 = agg.mostRecentVO2Max?.generic ?? null;

  // Nothing usable across any of the three DTOs → not available.
  if (!statusPick && !balancePick && !vo2) {
    return notAvailable();
  }

  // Device id/name: prefer the status entry's device, fall back to balance.
  const deviceId =
    statusPick !== null
      ? Number(statusPick.key)
      : balancePick !== null
        ? Number(balancePick.key)
        : null;
  const deviceName =
    findDeviceName(agg.mostRecentTrainingStatus?.recordedDevices, deviceId) ??
    findDeviceName(
      agg.mostRecentTrainingLoadBalance?.recordedDevices,
      deviceId,
    );

  let trainingStatus: TrainingStatusSummary['trainingStatus'] = null;
  let load: TrainingStatusSummary['load'] = null;
  if (statusPick) {
    const st = statusPick.entry;
    const warming = isWarming(
      st.trainingStatus,
      st.trainingStatusFeedbackPhrase,
    );
    trainingStatus = {
      statusCode: st.trainingStatus ?? null,
      feedbackPhrase: st.trainingStatusFeedbackPhrase ?? null,
      fitnessTrend: st.fitnessTrend ?? null,
      fitnessTrendSport: st.fitnessTrendSport ?? null,
      calendarDate: st.calendarDate ?? null,
      sinceDate: st.sinceDate ?? null,
      trainingPaused: st.trainingPaused ?? null,
      warming,
      ...(warming
        ? {
            note: 'Status warming up — the device needs more recent training history before it reports a training status.',
          }
        : {}),
    };
    const a = st.acuteTrainingLoadDTO;
    if (a) {
      load = {
        acuteLoad: a.dailyTrainingLoadAcute ?? null,
        chronicLoad: a.dailyTrainingLoadChronic ?? null,
        acwr: a.dailyAcuteChronicWorkloadRatio ?? null,
        acwrPercent: a.acwrPercent ?? null,
        acwrStatus: a.acwrStatus ?? null,
        acwrStatusFeedback: a.acwrStatusFeedback ?? null,
        chronicLoadRange: {
          min: a.minTrainingLoadChronic ?? null,
          max: a.maxTrainingLoadChronic ?? null,
        },
      };
    }
  }

  const vo2max: TrainingStatusSummary['vo2max'] = vo2
    ? {
        precise: vo2.vo2MaxPreciseValue ?? null,
        value: vo2.vo2MaxValue ?? null,
        fitnessAge: vo2.fitnessAge ?? null,
        calendarDate: vo2.calendarDate ?? null,
      }
    : null;

  let loadBalance: TrainingStatusSummary['loadBalance'] = null;
  if (balancePick) {
    const b = balancePick.entry;
    loadBalance = {
      aerobicLow: b.monthlyLoadAerobicLow ?? null,
      aerobicHigh: b.monthlyLoadAerobicHigh ?? null,
      anaerobic: b.monthlyLoadAnaerobic ?? null,
      aerobicLowTarget: {
        min: b.monthlyLoadAerobicLowTargetMin ?? null,
        max: b.monthlyLoadAerobicLowTargetMax ?? null,
      },
      aerobicHighTarget: {
        min: b.monthlyLoadAerobicHighTargetMin ?? null,
        max: b.monthlyLoadAerobicHighTargetMax ?? null,
      },
      anaerobicTarget: {
        min: b.monthlyLoadAnaerobicTargetMin ?? null,
        max: b.monthlyLoadAnaerobicTargetMax ?? null,
      },
      feedbackPhrase: b.trainingBalanceFeedbackPhrase ?? null,
      calendarDate: b.calendarDate ?? null,
    };
  }

  return {
    date,
    available: true,
    device:
      deviceId === null && deviceName === null ? null : {deviceId, deviceName},
    trainingStatus,
    load,
    vo2max,
    loadBalance,
  };
}
