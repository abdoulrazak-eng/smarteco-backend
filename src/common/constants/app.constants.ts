// ─── App Constants ───────────────────────────────

export const APP_NAME = 'Ejova';
export const API_PREFIX = 'api/v1';
export const SWAGGER_PATH = '/api/docs';

// ─── OTP ─────────────────────────────────────────

export const OTP_LENGTH = 6;
export const OTP_EXPIRY_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 3;
export const OTP_RATE_LIMIT_MINUTES = 1;
export const OTP_RATE_LIMIT_MAX = 3;
export const SANDBOX_OTP = '123456';

// ─── JWT ─────────────────────────────────────────

export const JWT_DEFAULT_EXPIRY = '24h';
export const JWT_REFRESH_DEFAULT_EXPIRY = '7d';

// ─── EcoPoints ───────────────────────────────────

export const ECOPOINTS = {
  REGISTRATION_BONUS: 100,
  REFERRAL_BONUS: 200,
  ORGANIC_PER_KG: 15,
  RECYCLABLE_PER_KG: 20,
  EWASTE_PER_ITEM: 50,
  GENERAL_PER_KG: 5,
  GLASS_PER_KG: 10,
  HAZARDOUS_PER_ITEM: 30,
  LANDFILL_PER_KG: 2,
};

// ─── Tier Thresholds ─────────────────────────────

export const TIER_THRESHOLDS = {
  ECO_STARTER: { min: 0, max: 499, multiplier: 1.0 },
  ECO_WARRIOR: { min: 500, max: 1999, multiplier: 1.25 },
  ECO_CHAMPION: { min: 2000, max: 9999, multiplier: 1.5 },
  ECO_LEGEND: { min: 10000, max: Infinity, multiplier: 2.0 },
};

// ─── AI Visual Sorting Points ────────────────────

export const AI_SORTING_POINTS = {
  PLASTIC: 10,
  PAPER: 5,
  METAL: 15,
  GLASS: 15,
  ORGANIC: 5,
  GENERAL: 2,
  RECYCLABLE: 10,
  RECYCLE: 10,
  COMPOST: 5,
  E_WASTE: 20,
  LANDFILL: 1,
  HAZARDOUS: 15,
};

// ─── Pickup ──────────────────────────────────────

export const PICKUP_REFERENCE_PREFIX = 'ECO-';
export const PICKUP_REFERENCE_LENGTH = 5;
export const PICKUP_MIN_ADVANCE_HOURS = 24;
export const MAX_PICKUPS_PER_COLLECTOR_PER_DAY = 8;
export const PICKUP_PRICES = {
  ORGANIC: 100,
  RECYCLABLE: 150,
  EWASTE: 500,
  GENERAL: 120,
  GLASS: 200,
  HAZARDOUS: 700,
  LANDFILL: 100,
};

export const MAX_COLLECTOR_ASSIGNMENT_DISTANCE_KM = 25;

// ─── Bin ─────────────────────────────────────────

export const BIN_QR_PREFIX = 'BIN-';
export const BIN_ALERT_THRESHOLD = 80; // percentage
export const BIN_AUTO_SCHEDULE_THRESHOLD = 95; // percentage
export const BINS_PER_USER = 6;

export const DEFAULT_CLIENT_BIN_TYPES = ['GENERAL', 'RECYCLABLE', 'ORGANIC'];
export const OPTIONAL_CLIENT_BIN_TYPES = ['EWASTE', 'HAZARDOUS', 'GLASS', 'LANDFILL'];

export const BIN_WASTE_TYPES = [
  'ORGANIC',
  'RECYCLABLE',
  'EWASTE',
  'GENERAL',
  'GLASS',
  'HAZARDOUS',
  'LANDFILL',
] as const;

export const ECOPOINT_REWARD_CATALOG = [
  {
    id: 'AIRTIME_1000_RWF',
    label: 'Airtime - 1,000 RWF',
    points: 500,
    type: 'AIRTIME',
  },
  {
    id: 'PICKUP_DISCOUNT_1000_RWF',
    label: 'Pickup discount - 1,000 RWF',
    points: 600,
    type: 'PICKUP_DISCOUNT',
  },
  {
    id: 'AIRTEL_MONEY_2000_RWF',
    label: 'Airtel Money - 2,000 RWF',
    points: 1000,
    type: 'AIRTEL_DISBURSEMENT',
  },
] as const;

// ─── Collector ───────────────────────────────────

export const DEFAULT_COLLECTOR_RATING = 5.0;
export const AVERAGE_CITY_SPEED_KMH = 30;

// ─── Rwanda ──────────────────────────────────────

export const RWANDA_COUNTRY_CODE = '+250';
export const DEFAULT_CURRENCY = 'RWF';
