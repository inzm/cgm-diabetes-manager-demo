/**
 * Database Entity Types
 * Fully aligned with docs/Web_Project/ARCHITECTURE.md Section 5
 */

export type UserRole = 'patient' | 'editor' | 'viewer';

export interface FamilyPermission {
  id: string; // UUID
  patient_id: string; // UUID
  family_user_id: string; // UUID
  role: 'viewer' | 'editor';
  invited_at: string;
  accepted_at?: string;
  created_at: string;
}

export interface LibreReading {
  id: string; // UUID
  user_id: string; // UUID (Patient)
  timestamp: string; // ISO 8601 TIMESTAMPTZ
  glucose_value: number; // mg/dL
  scan_type: 'Historic' | 'Scan';
  created_at: string;
}

export type EventType = '食事' | '活動' | '低血糖' | '高血糖';
export type TimingCategory = '朝食' | '昼食' | '夕食' | '間食' | '就寝前' | string;

export interface HealthEvent {
  id: string; // UUID
  user_id: string; // UUID (Patient)
  event_datetime: string; // ISO 8601 TIMESTAMPTZ
  event_type: EventType;
  timing_category?: TimingCategory;
  total_carbs?: number; // g
  insulin_units?: number; // 単位
  pre_meal_glucose?: number; // mg/dL
  post_meal_glucose?: number; // mg/dL
  duration_minutes?: number; // 分
  memo?: string;
  is_deleted: boolean;
  updated_at: string;
  created_at: string;
}

export interface MealDetail {
  id: string; // UUID
  user_id: string; // UUID (Patient)
  event_id: string; // UUID (HealthEvent FK)
  food_name: string;
  amount: number;
  unit: string;
  carbs: number; // g
  is_deleted: boolean;
  updated_at: string;
  created_at: string;
}

export interface Category {
  id: string; // UUID
  user_id: string; // UUID (Patient)
  target_type: 'food' | 'event';
  category_name: string;
  display_order: number;
  is_protected: boolean; // '未分類' は true
  is_deleted: boolean;
  updated_at: string;
  created_at: string;
}

export interface FoodMaster {
  id: string; // UUID
  user_id: string; // UUID (Patient)
  category_id?: string; // UUID (Category FK)
  food_name: string;
  base_amount: number;
  unit: string;
  carbs_per_unit: number; // g
  is_deleted: boolean;
  updated_at: string;
  created_at: string;
}

export interface EventMaster {
  id: string; // UUID
  user_id: string; // UUID (Patient)
  category_id?: string; // UUID (Category FK)
  event_name: string;
  default_duration: number; // 分
  memo?: string;
  is_deleted: boolean;
  updated_at: string;
  created_at: string;
}

export interface UserSettings {
  user_id: string; // UUID
  hypo_threshold: number; // default: 70.0
  hyper_threshold: number; // default: 180.0
  target_tir_min: number; // default: 70.0
  target_tir_max: number; // default: 180.0
  enable_default_insulin?: boolean; // default: false
  default_insulin_breakfast?: number | null;
  default_insulin_lunch?: number | null;
  default_insulin_dinner?: number | null;
  default_insulin_snack?: number | null;
  updated_at: string;
}

/**
 * ユーザー設定と食事区分からインスリン投与量入力欄の初期文字列を解決する
 * - enable_default_insulin が true かつ該当区分のデフォルト値が設定されている場合はその数値文字列を返す
 * - それ以外（OFF または未設定）の場合は空文字 '' を返す
 */
export function resolveDefaultInsulinInput(
  settings: UserSettings | undefined | null,
  timingCategory: string
): string {
  if (!settings || !settings.enable_default_insulin) {
    return '';
  }
  let val: number | null | undefined;
  switch (timingCategory) {
    case '朝食':
      val = settings.default_insulin_breakfast;
      break;
    case '昼食':
      val = settings.default_insulin_lunch;
      break;
    case '夕食':
      val = settings.default_insulin_dinner;
      break;
    case '間食':
      val = settings.default_insulin_snack;
      break;
    default:
      val = undefined;
  }
  if (val == null || Number.isNaN(val)) {
    return '';
  }
  return String(val);
}
