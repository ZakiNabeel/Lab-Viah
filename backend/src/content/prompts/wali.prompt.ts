// Wali Agent prompts — MASTERPLAN §5.6.
//
// The Wali brief is what gets read to (or by) the wali — typically the user's
// father or uncle — when a top-3 match needs family review. It must read like
// a respectful rishta summary, not a tech product feature.
//
// Two responsibilities:
//   1. buildWaliBriefPrompt — produces a structured brief in EN, UR, or RO_UR.
//      Pro-tier Gemini call (low volume, quality matters), JSON-mode.
//   2. fallbackBrief — deterministic brief assembled from the spec + report
//      when the model call fails. The voice is utilitarian rather than warm,
//      but the brief still ships and the trace records a recovery.

import type { CompatibilityReport } from '../../domain/scoring.js';
import type { TwinSpec } from '../../domain/twin.js';
import type { Dimension } from '../../domain/dimensions.js';

export type WaliBriefLanguage = 'en' | 'ur' | 'ro_ur';

export type WaliBriefPromptArgs = {
  language: WaliBriefLanguage;
  userSpec: TwinSpec;
  candidateSpec: TwinSpec;
  report: CompatibilityReport;
  // The wali this brief addresses ("Uncle Ahmed", "Walid sahab", etc.).
  // Mostly used in the salutation; the body refers to the user as their child.
  waliName: string;
  // The relation: "father", "uncle", etc. Drives the salutation register.
  waliRelation: 'father' | 'uncle' | 'brother' | 'guardian';
  // The user's name (the person whose match this is). Used in third person.
  userFirstName: string;
};

// =========================================================
// Prompt builders
// =========================================================

export function buildWaliBriefPrompt(args: WaliBriefPromptArgs): string {
  const langInstruction = LANGUAGE_INSTRUCTION[args.language];
  const candidate = args.candidateSpec;
  const report = args.report;

  const dimSummary = topAndBottomDims(report);
  const dealbreakerLine = report.dealbreakers_hit.length > 0
    ? `Dealbreaker(s) hit: ${report.dealbreakers_hit.join('; ')}`
    : 'No dealbreakers were triggered.';

  return `You are RishtaAI's Wali Agent. Compose a rishta brief that ${args.waliName} (${args.userFirstName}'s ${args.waliRelation}) can review on his/her phone. The tone is respectful, plain, and concrete. It is NOT a product pitch — it is a family-grade summary.

${langInstruction}

USER (the wali's ${args.waliRelation === 'father' || args.waliRelation === 'uncle' ? 'child/niece/nephew' : 'family member'}):
  - Name: ${args.userFirstName}
  - Age: ${args.userSpec.identity.age}, City: ${args.userSpec.identity.city}
  - Deen level: ${args.userSpec.deen_level}
  - Family setup expected: ${args.userSpec.family_setup}
  - Kids timeline: ${args.userSpec.kids_timeline}
  - Career: ${args.userSpec.career.current}

CANDIDATE:
  - Name: ${candidate.identity.name}
  - Age: ${candidate.identity.age}, City: ${candidate.identity.city}
  - Deen level: ${candidate.deen_level}
  - Family setup: ${candidate.family_setup} (family loyalty ${candidate.family_loyalty_score.toFixed(2)})
  - Career: ${candidate.career.current} → ${candidate.career.five_yr_goal}
  - Finances: ${candidate.finances.current_status}, ${candidate.finances.lifestyle_pref} lifestyle
  - Kids timeline: ${candidate.kids_timeline}
  - Conflict style: ${candidate.conflict_style}
  - Geography: ${candidate.geography.current_city}, 10yr → ${candidate.geography.ten_yr_pref} (flexible=${candidate.geography.flexible})

COMPATIBILITY ANALYSIS:
  - Overall score: ${(report.overall_score * 100).toFixed(0)}%
  - Recommendation: ${report.recommendation}
  - Top alignment dimensions: ${dimSummary.top.map((d) => `${d.dim} (${(d.score * 100).toFixed(0)}%)`).join(', ')}
  - Areas needing discussion: ${dimSummary.bottom.map((d) => `${d.dim} (${(d.score * 100).toFixed(0)}%)`).join(', ')}
  - ${dealbreakerLine}

PER-DIMENSION EVIDENCE:
${(Object.entries(report.dimension_scores) as [Dimension, { score: number; evidence: string }][])
  .sort((a, b) => b[1].score - a[1].score)
  .map(([d, r]) => `  - ${d} (${(r.score * 100).toFixed(0)}%): ${r.evidence}`)
  .join('\n')}

Output a single JSON object — no markdown, no commentary, no leading explanation:
{
  "salutation": "<one short respectful line addressing ${args.waliName} in the target language>",
  "headline": "<single sentence (≤ 20 words) summarizing why this match is being surfaced>",
  "candidate_summary": "<2 to 3 sentences describing the candidate in the target language: who they are, family, deen, career — what a rishta letter would say>",
  "alignment_points": ["<3 short phrases (≤ 18 words each) naming the strongest alignment areas with specifics, not platitudes>"],
  "discussion_points": ["<2 to 4 short phrases (≤ 22 words each) naming the real friction the family should discuss before moving forward — if a dealbreaker was hit, the FIRST entry must name it>"],
  "recommended_next_step": "<one sentence in the target language proposing what the wali should do next (meet in person, schedule a video call, decline politely)>",
  "compatibility_label": "<one short label in the target language for the compatibility tier: e.g. 'Strong match' / 'Match with conditions' / 'Not recommended at this time'>"
}

Rules:
- Write in ${LANGUAGE_NAME[args.language]} ONLY for every string field above. Do not mix scripts.
- Do not invent facts beyond what is in the analysis above. If something is unknown, leave it out rather than guess.
- "discussion_points" must be honest. A wali who reads only "alignment_points" cannot make a real decision. Surface real friction.
- If recommendation is "not_recommended", the headline and recommended_next_step must reflect that — do not soften.
- alignment_points: minimum 2 entries even if the match is weak (pick the least bad dimensions).
- Do NOT include emoji, hashtags, URLs, or marketing language.
- Output MUST be valid JSON. No trailing commas. No comments inside the JSON.`;
}

const LANGUAGE_NAME: Record<WaliBriefLanguage, string> = {
  en: 'English',
  ur: 'Urdu (Nastaliq script)',
  ro_ur: 'Roman Urdu (Urdu words written in Latin script)',
};

const LANGUAGE_INSTRUCTION: Record<WaliBriefLanguage, string> = {
  en: 'TARGET LANGUAGE: English. Use a warm but professional register — the tone of a family friend who happens to be careful with words. Avoid Arabic/Urdu loanwords unless they are standard in English rishta correspondence (e.g. "deen", "rishta", "nikah" are fine).',
  ur: 'TARGET LANGUAGE: Urdu, written in Nastaliq script. Use the respectful register a younger family member would use when addressing an elder (آپ form, نہیں آپ تو، etc.). Do not use English words except for proper nouns (city names, careers, ages can be numerals). Keep sentences short — this brief is read aloud.',
  ro_ur: 'TARGET LANGUAGE: Roman Urdu (Urdu in Latin script). Use the same respectful register as Urdu (aap form, never tum). Latin spelling — phonetic, what a Pakistani reader would actually write in a WhatsApp message. Mix English proper nouns naturally. Example phrasing: "Salaam Walid sahab, aap ki beti ka rishta..."',
};

// =========================================================
// Top / bottom dimensions
// =========================================================

function topAndBottomDims(report: CompatibilityReport): {
  top: { dim: Dimension; score: number }[];
  bottom: { dim: Dimension; score: number }[];
} {
  const sorted = (Object.entries(report.dimension_scores) as [Dimension, { score: number }][])
    .sort((a, b) => b[1].score - a[1].score)
    .map(([dim, r]) => ({ dim, score: r.score }));
  return {
    top: sorted.slice(0, 3),
    bottom: sorted.slice(-3).reverse(),
  };
}

// =========================================================
// Deterministic fallback (used when Gemini call fails)
// =========================================================
// Reads like an admin note rather than a warm rishta letter, but every field
// is populated so the workplan never deadlocks. Recovery event is logged at
// the agent boundary, not here.

export function fallbackBrief(args: WaliBriefPromptArgs): WaliBriefDocument {
  const r = args.report;
  const c = args.candidateSpec;
  const summary = topAndBottomDims(r);
  const pct = (r.overall_score * 100).toFixed(0);

  if (args.language === 'ur') {
    return {
      salutation: `السلام علیکم ${args.waliName} صاحب`,
      headline: `${args.userFirstName} کے لیے ایک مجوزہ رشتہ — ${c.identity.name} (${c.identity.age}، ${c.identity.city})`,
      candidate_summary: `${c.identity.name}، عمر ${c.identity.age} سال، ${c.identity.city} سے ہیں۔ پیشہ: ${c.career.current}۔ دین کی سطح: ${c.deen_level}۔ خاندانی ترتیب: ${c.family_setup}۔`,
      alignment_points: summary.top.map((d) => `${d.dim} میں ${(d.score * 100).toFixed(0)}% ہم آہنگی`),
      discussion_points: r.dealbreakers_hit.length > 0
        ? [r.dealbreakers_hit[0] ?? 'ایک اہم نکتہ زیرِ بحث ہے', ...summary.bottom.slice(0, 2).map((d) => `${d.dim} پر فرق`)]
        : summary.bottom.map((d) => `${d.dim} پر فرق ${(d.score * 100).toFixed(0)}%`),
      recommended_next_step: recommendNextStep(r.recommendation, 'ur'),
      compatibility_label: r.recommendation === 'strong_match' ? 'مضبوط رشتہ' : r.recommendation === 'conditional_match' ? 'مشروط رشتہ' : 'فی الحال موزوں نہیں',
      _pct: pct,
    };
  }

  if (args.language === 'ro_ur') {
    return {
      salutation: `Assalam-o-Alaikum ${args.waliName} sahab`,
      headline: `${args.userFirstName} ke liye ek mujoozah rishta — ${c.identity.name} (${c.identity.age}, ${c.identity.city})`,
      candidate_summary: `${c.identity.name}, umar ${c.identity.age} saal, ${c.identity.city} se hain. Pesha: ${c.career.current}. Deen level: ${c.deen_level}. Khandani tarteeb: ${c.family_setup}.`,
      alignment_points: summary.top.map((d) => `${d.dim} mein ${(d.score * 100).toFixed(0)}% hum-ahangi`),
      discussion_points: r.dealbreakers_hit.length > 0
        ? [r.dealbreakers_hit[0] ?? 'Ek aham nukta zer-e-behes hai', ...summary.bottom.slice(0, 2).map((d) => `${d.dim} par farq`)]
        : summary.bottom.map((d) => `${d.dim} par farq ${(d.score * 100).toFixed(0)}%`),
      recommended_next_step: recommendNextStep(r.recommendation, 'ro_ur'),
      compatibility_label: r.recommendation === 'strong_match' ? 'Mazboot rishta' : r.recommendation === 'conditional_match' ? 'Mashroot rishta' : 'Filhal mauzoon nahin',
      _pct: pct,
    };
  }

  return {
    salutation: `As-salamu alaikum, ${args.waliName}`,
    headline: `A proposed match for ${args.userFirstName}: ${c.identity.name} (${c.identity.age}, ${c.identity.city})`,
    candidate_summary: `${c.identity.name}, ${c.identity.age}, from ${c.identity.city}. Works as ${c.career.current}. Deen level: ${c.deen_level}. Family setup: ${c.family_setup}.`,
    alignment_points: summary.top.map((d) => `${d.dim}: ${(d.score * 100).toFixed(0)}% alignment`),
    discussion_points: r.dealbreakers_hit.length > 0
      ? [r.dealbreakers_hit[0] ?? 'A significant concern needs discussion', ...summary.bottom.slice(0, 2).map((d) => `${d.dim}: friction at ${(d.score * 100).toFixed(0)}%`)]
      : summary.bottom.map((d) => `${d.dim}: friction at ${(d.score * 100).toFixed(0)}%`),
    recommended_next_step: recommendNextStep(r.recommendation, 'en'),
    compatibility_label: r.recommendation === 'strong_match' ? 'Strong match' : r.recommendation === 'conditional_match' ? 'Match with conditions' : 'Not recommended at this time',
    _pct: pct,
  };
}

function recommendNextStep(
  rec: 'strong_match' | 'conditional_match' | 'not_recommended',
  lang: WaliBriefLanguage
): string {
  if (lang === 'ur') {
    return rec === 'strong_match'
      ? 'برائے مہربانی خاندان کے ساتھ ایک مختصر ملاقات کا بندوبست کرنے پر غور فرمائیں۔'
      : rec === 'conditional_match'
        ? 'پہلے زیرِ بحث نکات پر گفتگو فرمائیں، پھر ملاقات کا فیصلہ کریں۔'
        : 'فی الحال یہ رشتہ آگے نہ بڑھانے کا مشورہ ہے۔';
  }
  if (lang === 'ro_ur') {
    return rec === 'strong_match'
      ? 'Baraye meherbani khandan ke saath ek mukhtasar mulaqat ka bandobast karne par ghaur farmayen.'
      : rec === 'conditional_match'
        ? 'Pehle zer-e-behes nukaat par guftagu farmayen, phir mulaqat ka faisla karen.'
        : 'Filhal yeh rishta agay na barhane ka mashwara hai.';
  }
  return rec === 'strong_match'
    ? 'Consider arranging a brief, chaperoned meeting between the families.'
    : rec === 'conditional_match'
      ? 'Discuss the points above before deciding on a meeting.'
      : 'We recommend not pursuing this match at this time.';
}

// =========================================================
// Output shape
// =========================================================

export type WaliBriefDocument = {
  salutation: string;
  headline: string;
  candidate_summary: string;
  alignment_points: string[];
  discussion_points: string[];
  recommended_next_step: string;
  compatibility_label: string;
  // Compatibility percentage as a string (e.g. "72"). Computed locally, not by
  // the model — keeps the number consistent with the report.
  _pct: string;
};

// =========================================================
// Spoken-text composer
// =========================================================
// Flattens the structured brief into the text that gets passed to TTS. Skips
// punctuation-heavy fields and uses paragraph breaks so the voice has natural
// pause points.

export function flattenForSpeech(doc: WaliBriefDocument, language: WaliBriefLanguage): string {
  const sep = language === 'ur' ? '۔ ' : '. ';
  const parts = [
    doc.salutation,
    doc.headline,
    doc.candidate_summary,
    // Read alignment + discussion as connected sentences, not bullet lists —
    // bullets sound robotic when spoken.
    doc.alignment_points.join(sep),
    doc.discussion_points.join(sep),
    doc.recommended_next_step,
  ];
  return parts.filter((p) => p && p.trim().length > 0).join('\n\n');
}
