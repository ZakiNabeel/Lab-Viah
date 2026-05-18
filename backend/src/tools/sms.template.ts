// SMS template renderer — MASTERPLAN §1.9 + §13.
// NEVER sends a real SMS. Returns a rendered body + metadata so the mobile UI
// can display a "demo SMS" badge. The route logs trace events for every call
// so the Antigravity auditable trace includes all tool interactions.
//
// See ANTIGRAVITY.md §3 for the tool.call / tool.result trace contract.

import { AppError } from '../utils/errors.js';
import { type TraceBus } from '../agents/_shared/trace.js';

// =========================================================
// Public types
// =========================================================

export type SmsTemplate =
  | 'wali_brief_intro'   // First contact to wali: "Your relation has a match worth attention"
  | 'meeting_proposal'   // "Meeting proposed at venue on date"
  | 'meeting_confirmed'  // "Both walis confirmed. See you date"
  | 'meeting_reminder'   // "Reminder: meeting in Nh"
  | 'dispute_filed'      // "A dispute was filed regarding your match"
  | 'dispute_resolved';  // "Dispute outcome: severity, action: action"

export type SmsRenderInput = {
  template: SmsTemplate;
  toRole: 'user' | 'wali_user' | 'wali_candidate' | 'candidate';
  toPhone: string;            // E.164. Masked in trace.
  toName: string;
  language: 'ur' | 'ro_ur' | 'en';
  vars: Record<string, string | number>;
};

export type SmsRenderResult = {
  body: string;               // Rendered SMS text (≤320 chars / 2 segments).
  segments: number;           // Number of SMS segments the body would occupy.
  language: 'ur' | 'ro_ur' | 'en';
  template: SmsTemplate;
  sentAt: string;             // ISO timestamp of render ("delivery" in mock mode).
  delivered: true;            // Always true — mock pretends real delivery.
  mocked: true;               // Explicit flag for the mobile UI demo badge.
};

// =========================================================
// Required vars per template — used for validation
// =========================================================

const REQUIRED_VARS: Record<SmsTemplate, readonly string[]> = {
  wali_brief_intro:  ['userName', 'userAge', 'userCity', 'candidateName', 'candidateAge', 'candidateCity', 'compatibilityPct'],
  meeting_proposal:  ['userName', 'candidateName', 'venueName', 'venueArea', 'slotHuman', 'otherWaliName'],
  meeting_confirmed: ['userName', 'candidateName', 'venueName', 'slotHuman'],
  meeting_reminder:  ['userName', 'candidateName', 'venueName', 'slotHuman', 'hoursUntil'],
  dispute_filed:     ['userName', 'candidateName', 'disputeType'],
  dispute_resolved:  ['userName', 'candidateName', 'severityLabel', 'actionLabel'],
};

// =========================================================
// Template strings — 6 templates × 3 languages = 18 strings.
// Placeholders: {varName} for vars, {toName} for the recipient name from input.
// =========================================================

// wali_brief_intro: Sent to wali as the first formal notification of a candidate match.
const T_WALI_BRIEF_INTRO: Record<'ur' | 'ro_ur' | 'en', string> = {
  en:
    'As-salamu alaikum {toName}. RishtaAI has identified a strong potential match for {userName} ({userAge}, {userCity}) with {candidateName} ({candidateAge}, {candidateCity}). Compatibility: {compatibilityPct}%. Family review recommended. — RishtaAI',
  ro_ur:
    'As-salamu alaikum {toName}. RishtaAI ne {userName} ({userAge} saal, {userCity}) ke liye ek acha rishta dhoondha hai: {candidateName} ({candidateAge} saal, {candidateCity}). Muwafiqat: {compatibilityPct}%. Aap ki raay ka intezaar hai. — RishtaAI',
  ur:
    'السلام علیکم {toName}۔ RishtaAI نے {userName} ({userAge} سال، {userCity}) کے لیے ایک بہترین رشتہ تلاش کیا ہے: {candidateName} ({candidateAge} سال، {candidateCity})۔ مطابقت: {compatibilityPct}٪۔ خاندانی جائزہ تجویز کیا جاتا ہے۔ — RishtaAI',
};

// meeting_proposal: Wali receives a proposed meeting venue and time slot for family review.
const T_MEETING_PROPOSAL: Record<'ur' | 'ro_ur' | 'en', string> = {
  en:
    'As-salamu alaikum {toName}. A family meeting has been proposed for {userName} and {candidateName} at {venueName}, {venueArea} on {slotHuman}. Wali {otherWaliName} has been notified. Please confirm at your earliest. — RishtaAI',
  ro_ur:
    'As-salamu alaikum {toName}. {userName} aur {candidateName} ki family mulaqat {venueName}, {venueArea} mein {slotHuman} ko muqarrar ki gayi hai. Wali {otherWaliName} ko bhi bataya gaya hai. Tassdeq farmayein. — RishtaAI',
  ur:
    'السلام علیکم {toName}۔ {userName} اور {candidateName} کی خاندانی ملاقات {venueName}، {venueArea} میں {slotHuman} کو تجویز کی گئی ہے۔ ولی {otherWaliName} کو بھی اطلاع دی گئی ہے۔ براہ کرم تصدیق فرمائیں۔ — RishtaAI',
};

// meeting_confirmed: Sent to both walis once both sides have confirmed the meeting.
const T_MEETING_CONFIRMED: Record<'ur' | 'ro_ur' | 'en', string> = {
  en:
    'As-salamu alaikum {toName}. Both families have confirmed the meeting for {userName} and {candidateName} at {venueName} on {slotHuman}. Jazak Allah khayran. — RishtaAI',
  ro_ur:
    'As-salamu alaikum {toName}. Dono khandanon ne {userName} aur {candidateName} ki {venueName} mein {slotHuman} ki mulaqat ki tassdeq kar di hai. Jazak Allah khayran. — RishtaAI',
  ur:
    'السلام علیکم {toName}۔ دونوں خاندانوں نے {userName} اور {candidateName} کی {venueName} میں {slotHuman} کی ملاقات کی تصدیق کر دی ہے۔ جزاک اللہ خیراً۔ — RishtaAI',
};

// meeting_reminder: Short reminder sent a few hours before the confirmed meeting.
const T_MEETING_REMINDER: Record<'ur' | 'ro_ur' | 'en', string> = {
  en:
    'Reminder {toName}: the meeting for {userName} and {candidateName} at {venueName} is in {hoursUntil} hour(s) — {slotHuman}. Safe travels. — RishtaAI',
  ro_ur:
    'Yaad dihani {toName}: {userName} aur {candidateName} ki {venueName} mein mulaqat {hoursUntil} ghantay mein hai — {slotHuman}. Allah Hafiz. — RishtaAI',
  ur:
    'یاد دہانی {toName}: {userName} اور {candidateName} کی {venueName} میں ملاقات {hoursUntil} گھنٹے میں ہے — {slotHuman}۔ اللہ حافظ۔ — RishtaAI',
};

// dispute_filed: Notifies a party that a dispute has been formally raised against this match.
const T_DISPUTE_FILED: Record<'ur' | 'ro_ur' | 'en', string> = {
  en:
    'As-salamu alaikum {toName}. A dispute of type "{disputeType}" has been filed regarding the match between {userName} and {candidateName}. Our moderator will review and contact you shortly. — RishtaAI',
  ro_ur:
    'As-salamu alaikum {toName}. {userName} aur {candidateName} ke rishte mein "{disputeType}" qisam ka ikhtelaf darj kiya gaya hai. Hamara moderator jald rabta karega. — RishtaAI',
  ur:
    'السلام علیکم {toName}۔ {userName} اور {candidateName} کے رشتے میں "{disputeType}" قسم کا اختلاف درج کیا گیا ہے۔ ہمارا ثالث جلد رابطہ کرے گا۔ — RishtaAI',
};

// dispute_resolved: Final notification once the moderator has issued a ruling.
const T_DISPUTE_RESOLVED: Record<'ur' | 'ro_ur' | 'en', string> = {
  en:
    'As-salamu alaikum {toName}. The dispute regarding {userName} and {candidateName} has been resolved. Severity: {severityLabel}. Action taken: {actionLabel}. May Allah ease your affairs. — RishtaAI',
  ro_ur:
    'As-salamu alaikum {toName}. {userName} aur {candidateName} ka ikhtelaf hal ho gaya. Darjah: {severityLabel}. Iqdam: {actionLabel}. Allah aasaan kare. — RishtaAI',
  ur:
    'السلام علیکم {toName}۔ {userName} اور {candidateName} کا اختلاف حل ہو گیا۔ درجہ: {severityLabel}۔ اقدام: {actionLabel}۔ اللہ آسان کرے۔ — RishtaAI',
};

// Master nested map: TEMPLATES[template][language] → raw template string.
const TEMPLATES: Record<SmsTemplate, Record<'ur' | 'ro_ur' | 'en', string>> = {
  wali_brief_intro:  T_WALI_BRIEF_INTRO,
  meeting_proposal:  T_MEETING_PROPOSAL,
  meeting_confirmed: T_MEETING_CONFIRMED,
  meeting_reminder:  T_MEETING_REMINDER,
  dispute_filed:     T_DISPUTE_FILED,
  dispute_resolved:  T_DISPUTE_RESOLVED,
};

// =========================================================
// Internals
// =========================================================

/** Mask E.164 phone: keep country code (up to first 3 chars after +) + last 4 digits. */
function maskPhone(phone: string): string {
  // E.g. +923001234567 → +92****4567
  const match = /^(\+\d{1,3})(\d*)(\d{4})$/.exec(phone);
  if (!match) return '+****';
  const [, cc, , last4] = match;
  return `${cc ?? ''}****${last4 ?? ''}`;
}

/**
 * Determine SMS segment count.
 * GSM-7 alphabet: 160 chars/segment.
 * Unicode (any non-GSM char present): 70 chars/segment.
 */
function countSegments(body: string): number {
  // GSM-7 basic character set (printable ASCII subset + a few extras).
  // Using a range check: all chars must be in the GSM-7 set.
  // Simplification: treat as GSM-7 only if every code point is <= 0x7E
  // and no char is outside standard ASCII printable range.
  const isGsm7 = [...body].every((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    // GSM-7 covers printable ASCII (0x20–0x7E) plus \n, \r, \t.
    return (cp >= 0x20 && cp <= 0x7e) || cp === 0x0a || cp === 0x0d || cp === 0x09;
  });
  const charsPerSegment = isGsm7 ? 160 : 70;
  return Math.ceil(body.length / charsPerSegment);
}

/** Substitute {key} placeholders in template string. */
function interpolate(
  template: string,
  vars: Record<string, string | number>,
  toName: string
): string {
  // Build a combined lookup that includes toName as an implicit var.
  const allVars: Record<string, string | number> = { ...vars, toName };
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const val = allVars[key];
    return val !== undefined ? String(val) : `{${key}}`;
  });
}

// =========================================================
// Main export
// =========================================================

export async function smsRender(input: SmsRenderInput, bus?: TraceBus): Promise<SmsRenderResult> {
  const start = Date.now();

  // Emit tool.call with masked phone and only var keys (no values = no PII leak).
  bus?.emit({
    type: 'tool.call',
    tool: 'smsRender',
    args: {
      template: input.template,
      toRole: input.toRole,
      toPhoneMasked: maskPhone(input.toPhone),
      language: input.language,
      varsKeys: Object.keys(input.vars),
    },
    ts: start,
  });

  // Validate required vars before rendering.
  const required = REQUIRED_VARS[input.template];
  for (const key of required) {
    if (input.vars[key] === undefined) {
      throw new AppError(
        'BAD_REQUEST',
        `smsRender: missing required var "${key}" for template "${input.template}"`,
        { template: input.template, missingVar: key }
      );
    }
  }

  // Retrieve template string — both lookups are guarded because noUncheckedIndexedAccess is on.
  const langMap = TEMPLATES[input.template];
  if (!langMap) {
    throw new AppError('BAD_REQUEST', `smsRender: unknown template "${input.template}"`);
  }
  const rawTemplate = langMap[input.language];
  if (!rawTemplate) {
    throw new AppError(
      'BAD_REQUEST',
      `smsRender: no template string for template="${input.template}" language="${input.language}"`
    );
  }

  const body = interpolate(rawTemplate, input.vars, input.toName);
  const segments = countSegments(body);

  // Cap: 4 segments. Unicode (Urdu) is 70 chars/segment so even a moderate
  // brief lands at 3-4 segments. Real rishta-grade SMS routinely span 3-4
  // segments; we cap at 4 to catch runaway template bugs without blocking
  // legitimate content.
  if (segments > 4) {
    throw new AppError(
      'BAD_REQUEST',
      `smsRender: rendered body is ${body.length} chars (${segments} segments) — exceeds 4-segment limit. Shorten the template.`,
      { template: input.template, language: input.language, bodyLength: body.length, segments }
    );
  }

  const result: SmsRenderResult = {
    body,
    segments,
    language: input.language,
    template: input.template,
    sentAt: new Date(start).toISOString(),
    delivered: true,
    mocked: true,
  };

  // Emit tool.result — no PII in the summary.
  bus?.emit({
    type: 'tool.result',
    tool: 'smsRender',
    result: {
      template: result.template,
      language: result.language,
      bodyChars: body.length,
      segments: result.segments,
      mocked: true,
    },
    latency_ms: Date.now() - start,
    ts: Date.now(),
  });

  // Use await to satisfy the async contract even though no I/O occurs.
  await Promise.resolve();
  return result;
}
