/**
 * Synthetic unit acceptance for the nutrition transform (pure, no Garmin
 * account). Feeds hand-built food-log fixtures through transformNutrition()
 * and asserts macro extraction, the calorie-only null-coalescing (missing
 * macro ≠ 0g), goal shaping, loggedItemCount, per-meal macros/micros/foods,
 * and the empty (never-logged / pre-account) case.
 *
 *   npx tsx scripts/nutrition-test.ts
 */
import {transformNutrition} from '../src/nutrition.js';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures += 1;
}

// --- Fixture 1: full-macro day (itemized foods logged), mirroring live shape ---
const fullDay = {
  mealDate: '2026-06-29',
  dayStartTime: '07:00:00',
  dailyNutritionGoals: {
    calories: 2288,
    adjustedCalories: 3128,
    carbs: 229,
    adjustedCarbs: 313,
    fat: 76,
    adjustedFat: 104,
    protein: 172,
    adjustedProtein: 235,
  },
  dailyNutritionContent: {
    calories: 1642,
    carbs: 71,
    fat: 82,
    protein: 160,
    caloriesPercentage: 53,
  },
  mealDetails: [
    {
      meal: {mealId: 1169764, mealName: 'BREAKFAST'},
      mealNutritionContent: {
        calories: 180,
        carbs: 1,
        protein: 10,
        fat: 15,
        fiber: 0,
        sugar: 1,
        addedSugars: 0,
        saturatedFat: 5,
        transFat: 0,
        cholesterol: 40,
        sodium: 390,
        potassium: 150,
        vitaminD: 0,
        calcium: 10,
        iron: 0.5,
      },
      loggedFoods: [
        {
          foodMetaData: {
            foodName: 'Ground Hot Italian Sausage',
            brandName: 'Johnsonville',
            source: 'FATSECRET',
          },
          nutritionContent: {
            servingUnit: '2 oz cooked',
            numberOfUnits: 1,
            calories: 180,
            carbs: 1,
            protein: 10,
            fat: 15,
            fiber: 0,
            sodium: 390,
          },
        },
      ],
    },
    {
      meal: {mealId: 1169766, mealName: 'DINNER'},
      // No content logged to this meal yet.
      loggedFoods: [],
    },
  ],
};

const full = transformNutrition(fullDay, '2026-06-29');
check('full-macro day flagged hasMacros', full.hasMacros === true);
check(
  'daily consumed macros extracted (grams)',
  full.consumed.calories === 1642 &&
    full.consumed.carbs === 71 &&
    full.consumed.fat === 82 &&
    full.consumed.protein === 160,
  JSON.stringify(full.consumed),
);
check(
  'caloriesPercentage is not surfaced at top level',
  !('caloriesPercentage' in full.consumed),
);
check(
  'daily goals shaped (base + adjusted)',
  full.goals.calories === 2288 &&
    full.goals.adjustedCarbs === 313 &&
    full.goals.protein === 172,
  JSON.stringify(full.goals),
);
check('loggedItemCount counts foods across meals', full.loggedItemCount === 1);
check(
  'per-meal macros extracted',
  full.meals[0].name === 'BREAKFAST' &&
    full.meals[0].consumed?.protein === 10 &&
    full.meals[0].consumed?.calories === 180,
  JSON.stringify(full.meals[0].consumed),
);
check(
  'per-meal micros nested under consumed.micros',
  full.meals[0].consumed?.micros.sodium === 390 &&
    full.meals[0].consumed?.micros.saturatedFat === 5 &&
    full.meals[0].consumed?.micros.iron === 0.5,
  JSON.stringify(full.meals[0].consumed?.micros),
);
check(
  'logged food carries name, brand, serving, per-serving macros',
  full.meals[0].foods[0].name === 'Ground Hot Italian Sausage' &&
    full.meals[0].foods[0].brand === 'Johnsonville' &&
    full.meals[0].foods[0].servingUnit === '2 oz cooked' &&
    full.meals[0].foods[0].protein === 10,
  JSON.stringify(full.meals[0].foods[0]),
);
check(
  'meal with nothing logged has null consumed and no foods',
  full.meals[1].consumed === null && full.meals[1].foods.length === 0,
  JSON.stringify(full.meals[1]),
);

// --- Fixture 2: calorie-only day (no itemized foods) — macros must be null ---
const calorieOnly = {
  mealDate: '2026-06-24',
  dailyNutritionGoals: {calories: 2780, adjustedCalories: 3024},
  dailyNutritionContent: {calories: 3102, caloriesPercentage: 103},
  mealDetails: [{meal: {mealName: 'BREAKFAST'}, loggedFoods: []}],
};
const co = transformNutrition(calorieOnly, '2026-06-24');
check('calorie-only day flagged hasMacros=false', co.hasMacros === false);
check(
  'calorie-only: calories present, macros NULL (not zero)',
  co.consumed.calories === 3102 &&
    co.consumed.carbs === null &&
    co.consumed.fat === null &&
    co.consumed.protein === null,
  JSON.stringify(co.consumed),
);
check(
  'calorie-only: macro goals null, calorie goal present',
  co.goals.calories === 2780 &&
    co.goals.carbs === null &&
    co.goals.adjustedProtein === null,
  JSON.stringify(co.goals),
);
check('calorie-only: loggedItemCount is 0', co.loggedItemCount === 0);

// --- Fixture 3: empty (never-logged / pre-account) → null-filled, no throw ---
const emptyArr = transformNutrition([], '2019-01-01');
check(
  'empty array → hasMacros false, null macros, no throw',
  emptyArr.hasMacros === false &&
    emptyArr.consumed.calories === null &&
    emptyArr.loggedItemCount === 0 &&
    emptyArr.meals.length === 0,
  JSON.stringify(emptyArr.consumed),
);
const emptyNull = transformNutrition(null, '2099-01-01');
check(
  'null payload → null-filled result',
  emptyNull.hasMacros === false && emptyNull.consumed.protein === null,
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
