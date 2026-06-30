/**
 * Pure transform from Garmin's native food-log payload
 * (/nutrition-service/food/logs/{date}) into a clean nutrition summary. This
 * is the in-Garmin food logging that shipped with Connect+ (Jan 2026), not
 * the old MyFitnessPal sync — so protein/carb/fat grams are present here even
 * though they never appear in the usersummary daily summary.
 *
 * Two day shapes exist and both must be handled:
 *  - "full macro" days: the user logged itemized foods, so dailyNutrition
 *    content carries calories + carbs/fat/protein grams and per-meal micros.
 *  - "calorie-only" days: only a calorie number was entered (no foods), so
 *    the macro grams are simply absent. Those stay null (never zero) so a
 *    missing macro is never mistaken for "ate 0g".
 *
 * No Garmin client here, so it stays unit-testable without an account.
 */

/** Daily/per-meal consumed macros as they arrive (any field may be absent). */
interface RawNutritionContent {
  calories?: number;
  carbs?: number;
  fat?: number;
  protein?: number;
  // Micros — only present on itemized (full-macro) days.
  fiber?: number;
  sugar?: number;
  addedSugars?: number;
  saturatedFat?: number;
  transFat?: number;
  cholesterol?: number;
  sodium?: number;
  potassium?: number;
  vitaminD?: number;
  calcium?: number;
  iron?: number;
  servingUnit?: string;
  numberOfUnits?: number;
}

interface RawDailyGoals {
  calories?: number;
  adjustedCalories?: number;
  carbs?: number;
  adjustedCarbs?: number;
  fat?: number;
  adjustedFat?: number;
  protein?: number;
  adjustedProtein?: number;
}

interface RawLoggedFood {
  foodMetaData?: {foodName?: string; brandName?: string};
  nutritionContent?: RawNutritionContent;
}

interface RawMealDetail {
  meal?: {mealName?: string};
  mealNutritionContent?: RawNutritionContent;
  loggedFoods?: RawLoggedFood[];
}

interface RawFoodLog {
  mealDate?: string;
  dailyNutritionContent?: RawNutritionContent;
  dailyNutritionGoals?: RawDailyGoals;
  mealDetails?: RawMealDetail[];
}

/** Macro grams; each null when Garmin omits it (e.g. a calorie-only day). */
export interface Macros {
  calories: number | null;
  carbs: number | null;
  fat: number | null;
  protein: number | null;
}

/** Micronutrients Garmin includes for free on itemized days; null if absent. */
export interface Micros {
  fiber: number | null;
  sugar: number | null;
  addedSugars: number | null;
  saturatedFat: number | null;
  transFat: number | null;
  cholesterol: number | null;
  sodium: number | null;
  potassium: number | null;
  vitaminD: number | null;
  calcium: number | null;
  iron: number | null;
}

export interface DailyGoals {
  calories: number | null;
  adjustedCalories: number | null;
  carbs: number | null;
  adjustedCarbs: number | null;
  fat: number | null;
  adjustedFat: number | null;
  protein: number | null;
  adjustedProtein: number | null;
}

export interface LoggedFoodSummary {
  name: string | null;
  brand: string | null;
  servingUnit: string | null;
  numberOfUnits: number | null;
  /** Macros for the logged quantity (not per single serving). */
  calories: number | null;
  carbs: number | null;
  fat: number | null;
  protein: number | null;
}

export interface MealSummary {
  name: string | null;
  /** Consumed macros for this meal; null when nothing was logged to it. */
  consumed: (Macros & {micros: Micros}) | null;
  foods: LoggedFoodSummary[];
}

export interface NutritionSummary {
  date: string;
  /**
   * True when macro grams are present (the day was logged as itemized foods).
   * False on calorie-only days, where consumed.carbs/fat/protein are null.
   */
  hasMacros: boolean;
  /** Daily consumed totals in grams; macros null on calorie-only days. */
  consumed: Macros;
  /** Daily targets straight from Garmin (base + activity-adjusted). */
  goals: DailyGoals;
  /** Count of individually logged foods across all meals (0 = calorie-only). */
  loggedItemCount: number;
  meals: MealSummary[];
}

const n = (v: number | undefined): number | null => v ?? null;

function toMacros(c: RawNutritionContent | undefined): Macros {
  return {
    calories: n(c?.calories),
    carbs: n(c?.carbs),
    fat: n(c?.fat),
    protein: n(c?.protein),
  };
}

function toMicros(c: RawNutritionContent | undefined): Micros {
  return {
    fiber: n(c?.fiber),
    sugar: n(c?.sugar),
    addedSugars: n(c?.addedSugars),
    saturatedFat: n(c?.saturatedFat),
    transFat: n(c?.transFat),
    cholesterol: n(c?.cholesterol),
    sodium: n(c?.sodium),
    potassium: n(c?.potassium),
    vitaminD: n(c?.vitaminD),
    calcium: n(c?.calcium),
    iron: n(c?.iron),
  };
}

function toGoals(g: RawDailyGoals | undefined): DailyGoals {
  return {
    calories: n(g?.calories),
    adjustedCalories: n(g?.adjustedCalories),
    carbs: n(g?.carbs),
    adjustedCarbs: n(g?.adjustedCarbs),
    fat: n(g?.fat),
    adjustedFat: n(g?.adjustedFat),
    protein: n(g?.protein),
    adjustedProtein: n(g?.adjustedProtein),
  };
}

function toFood(f: RawLoggedFood): LoggedFoodSummary {
  const c = f.nutritionContent;
  return {
    name: f.foodMetaData?.foodName ?? null,
    brand: f.foodMetaData?.brandName ?? null,
    servingUnit: c?.servingUnit ?? null,
    numberOfUnits: n(c?.numberOfUnits),
    calories: n(c?.calories),
    carbs: n(c?.carbs),
    fat: n(c?.fat),
    protein: n(c?.protein),
  };
}

export function transformNutrition(
  raw: unknown,
  date: string,
): NutritionSummary {
  const empty = (): NutritionSummary => ({
    date,
    hasMacros: false,
    consumed: {calories: null, carbs: null, fat: null, protein: null},
    goals: toGoals(undefined),
    loggedItemCount: 0,
    meals: [],
  });

  // Pre-account / future / never-logged dates can come back empty or non-object.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty();
  const log = raw as RawFoodLog;

  const consumed = toMacros(log.dailyNutritionContent);
  // Itemized days carry all three macros; calorie-only days carry none.
  const hasMacros =
    consumed.carbs !== null &&
    consumed.fat !== null &&
    consumed.protein !== null;

  const meals: MealSummary[] = (log.mealDetails ?? []).map(md => {
    const foods = (md.loggedFoods ?? []).map(toFood);
    return {
      name: md.meal?.mealName ?? null,
      consumed: md.mealNutritionContent
        ? {
            ...toMacros(md.mealNutritionContent),
            micros: toMicros(md.mealNutritionContent),
          }
        : null,
      foods,
    };
  });
  const loggedItemCount = meals.reduce((sum, m) => sum + m.foods.length, 0);

  return {
    date: log.mealDate ?? date,
    hasMacros,
    consumed,
    goals: toGoals(log.dailyNutritionGoals),
    loggedItemCount,
    meals,
  };
}
