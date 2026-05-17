// 12 scenario cards — MASTERPLAN §8.1 layer 2. Each card has 3–4 options.
// An option's `contributions` are signed deltas in [-1..1] applied to the
// user's personality vector along the named dimension(s). The vector is later
// L2-clamped and merged with the structured Layer-1 payload at Twin Forge time.
//
// Authoring philosophy: every card tests a value tension that *actually*
// surfaces in Pakistani rishta conversations (joint vs nuclear family, deen
// rigor, kids timing, wife working, geography). No abstract personality
// questions ("are you an introvert?") — every card maps to a Twin dimension.

import type { Dimension } from '../domain/dimensions.js';

export type LocalizedString = { en: string; ur: string; ro_ur: string };

export type ScenarioOption = {
  id: string;
  label: LocalizedString;
  contributions: Partial<Record<Dimension, number>>;
};

export type ScenarioCard = {
  id: string;
  title: LocalizedString;
  prompt: LocalizedString;
  options: ScenarioOption[];
};

export const SCENARIO_CARDS: readonly ScenarioCard[] = [
  // ---------- 1. Deen: salah rigor ----------
  {
    id: 'card_salah',
    title: { en: 'Salah on a busy workday', ur: 'مصروف دن میں نماز', ro_ur: 'Busy din mein namaz' },
    prompt: {
      en: 'Your spouse has back-to-back meetings and misses Asr. How should the household handle it?',
      ur: 'اگر شریک حیات کی پے در پے میٹنگز ہوں اور عصر چھوٹ جائے تو گھر میں کیا کیا جائے؟',
      ro_ur: 'Agar partner ki back-to-back meetings hon aur Asr reh jaye to ghar mein kya kiya jaye?',
    },
    options: [
      {
        id: 'a',
        label: {
          en: 'Salah comes first — meetings can be rescheduled',
          ur: 'نماز پہلے، میٹنگز بعد میں',
          ro_ur: 'Namaz pehle, meetings baad mein',
        },
        contributions: { deen: 0.9 },
      },
      {
        id: 'b',
        label: {
          en: 'Combine Asr with Maghrib when work demands it',
          ur: 'ضرورت پر عصر مغرب کے ساتھ ملا لیں',
          ro_ur: 'Zarurat par Asr Maghrib ke sath',
        },
        contributions: { deen: 0.3 },
      },
      {
        id: 'c',
        label: {
          en: 'No judgement either way — qadha later',
          ur: 'کوئی پابندی نہیں — قضاء بعد میں',
          ro_ur: 'Koi pabandi nahi — qadha baad mein',
        },
        contributions: { deen: -0.4 },
      },
    ],
  },

  // ---------- 2. Family: in-law co-residence ----------
  {
    id: 'card_inlaws',
    title: { en: 'Living with in-laws', ur: 'سسرال کے ساتھ رہائش', ro_ur: 'Sasural ke sath rehna' },
    prompt: {
      en: 'After marriage, where should the couple live?',
      ur: 'شادی کے بعد جوڑے کو کہاں رہنا چاہیے؟',
      ro_ur: 'Shadi ke baad couple ko kahan rehna chahiye?',
    },
    options: [
      {
        id: 'a',
        label: {
          en: 'Joint family home — that is the norm',
          ur: 'مشترکہ خاندانی گھر',
          ro_ur: 'Joint family ghar',
        },
        contributions: { family: 0.9 },
      },
      {
        id: 'b',
        label: {
          en: 'Same building, separate floor',
          ur: 'ایک عمارت، الگ منزل',
          ro_ur: 'Aik building, alag floor',
        },
        contributions: { family: 0.4 },
      },
      {
        id: 'c',
        label: {
          en: 'Separate house, visit often',
          ur: 'الگ گھر، اکثر ملاقات',
          ro_ur: 'Alag ghar, milne aate jaate rahein',
        },
        contributions: { family: -0.3 },
      },
      {
        id: 'd',
        label: {
          en: 'Wherever our careers take us',
          ur: 'جہاں کیریئر لے جائے',
          ro_ur: 'Jahan career le jaye',
        },
        contributions: { family: -0.7, career: 0.4 },
      },
    ],
  },

  // ---------- 3. Career: spouse working after kids ----------
  {
    id: 'card_spouse_working',
    title: { en: 'Working after kids', ur: 'بچوں کے بعد ملازمت', ro_ur: 'Bachon ke baad job' },
    prompt: {
      en: 'After the first child, do you expect your spouse to continue working?',
      ur: 'پہلے بچے کے بعد، کیا آپ چاہیں گے کہ شریکِ حیات کام جاری رکھے؟',
      ro_ur: 'Pehle bachay ke baad, partner kaam jari rakhe?',
    },
    options: [
      {
        id: 'a',
        label: {
          en: 'Of course — career is non-negotiable',
          ur: 'بالکل — کیریئر اہم ہے',
          ro_ur: 'Bilkul — career zaroori hai',
        },
        contributions: { career: 0.9, family: -0.2 },
      },
      {
        id: 'b',
        label: {
          en: 'Part-time / flexible until kids start school',
          ur: 'پارٹ ٹائم، اسکول تک',
          ro_ur: 'Part-time, school tak',
        },
        contributions: { career: 0.4, family: 0.2 },
      },
      {
        id: 'c',
        label: {
          en: 'Prefer they focus on home',
          ur: 'گھر پر توجہ بہتر',
          ro_ur: 'Ghar pe focus behtar',
        },
        contributions: { career: -0.6, family: 0.6 },
      },
    ],
  },

  // ---------- 4. Finances: lifestyle preference ----------
  {
    id: 'card_lifestyle',
    title: { en: 'Lifestyle aspirations', ur: 'طرز زندگی', ro_ur: 'Lifestyle' },
    prompt: {
      en: 'Pick the household lifestyle that matches your ideal:',
      ur: 'اپنی پسند کا طرز زندگی منتخب کریں:',
      ro_ur: 'Apni pasand ka lifestyle chunein:',
    },
    options: [
      {
        id: 'a',
        label: {
          en: 'Simple — save aggressively, invest in family',
          ur: 'سادہ — بچت اور خاندان',
          ro_ur: 'Simple — savings aur family',
        },
        contributions: { finances: -0.5 },
      },
      {
        id: 'b',
        label: {
          en: 'Comfortable — own a home, annual umrah, kids in good school',
          ur: 'آرام دہ — اپنا گھر، سالانہ عمرہ، اچھا اسکول',
          ro_ur: 'Comfortable — apna ghar, umrah, acha school',
        },
        contributions: { finances: 0.2 },
      },
      {
        id: 'c',
        label: {
          en: 'Aspirational — DHA/Bahria, international travel, premium brands',
          ur: 'پر آسائش — ڈی ایچ اے، بین الاقوامی سفر',
          ro_ur: 'Aspirational — DHA/Bahria, foreign trips',
        },
        contributions: { finances: 0.8 },
      },
    ],
  },

  // ---------- 5. Kids: timing ----------
  {
    id: 'card_kids_timing',
    title: { en: 'When to have kids', ur: 'بچے کب', ro_ur: 'Bache kab' },
    prompt: {
      en: 'When do you envision your first child?',
      ur: 'پہلا بچہ کب ہونا چاہیے؟',
      ro_ur: 'Pehla bacha kab hona chahiye?',
    },
    options: [
      {
        id: 'a',
        label: { en: 'Within the first year', ur: 'پہلے سال میں', ro_ur: 'Pehle saal mein' },
        contributions: { kids: 0.9, career: -0.2 },
      },
      {
        id: 'b',
        label: { en: '2–3 years in', ur: '2–3 سال بعد', ro_ur: '2–3 saal baad' },
        contributions: { kids: 0.4 },
      },
      {
        id: 'c',
        label: { en: '5+ years, after we are financially set', ur: '5+ سال بعد', ro_ur: '5+ saal baad' },
        contributions: { kids: -0.2, finances: 0.3 },
      },
      {
        id: 'd',
        label: { en: 'Open to no kids', ur: 'بچوں کے بغیر بھی ٹھیک', ro_ur: 'Bachon ke bina bhi theek' },
        contributions: { kids: -0.9 },
      },
    ],
  },

  // ---------- 6. Conflict: disagreement style ----------
  {
    id: 'card_conflict',
    title: { en: 'When you disagree', ur: 'اختلاف کی صورت میں', ro_ur: 'Ikhtilaf ki surat mein' },
    prompt: {
      en: 'A serious disagreement about money. What is your default move?',
      ur: 'پیسوں پر سنگین اختلاف۔ آپ کیا کریں گے؟',
      ro_ur: 'Paison par serious disagreement — aap kya karenge?',
    },
    options: [
      {
        id: 'a',
        label: { en: 'Talk it out same night', ur: 'اسی رات بات کر لیں', ro_ur: 'Usi raat baat kar lein' },
        contributions: { conflict: 0.7 },
      },
      {
        id: 'b',
        label: { en: 'Cool off, then revisit', ur: 'ٹھنڈا ہو کر بات کریں', ro_ur: 'Cool off karke baat' },
        contributions: { conflict: 0.3 },
      },
      {
        id: 'c',
        label: { en: 'Ask elders to mediate', ur: 'بزرگوں سے رجوع', ro_ur: 'Buzurgon se baat' },
        contributions: { conflict: -0.5, family: 0.4 },
      },
      {
        id: 'd',
        label: { en: 'Avoid the topic for a while', ur: 'موضوع سے گریز', ro_ur: 'Topic se grez' },
        contributions: { conflict: -0.7 },
      },
    ],
  },

  // ---------- 7. Geography: relocation ----------
  {
    id: 'card_geography',
    title: { en: 'Where you see life in 10 years', ur: '10 سال بعد کہاں؟', ro_ur: '10 saal baad kahan?' },
    prompt: {
      en: 'In 10 years, where do you see the family living?',
      ur: '10 سال بعد آپ کا خاندان کہاں ہوگا؟',
      ro_ur: '10 saal baad family kahan hogi?',
    },
    options: [
      {
        id: 'a',
        label: { en: 'Same city — roots matter', ur: 'وہی شہر — جڑیں اہم', ro_ur: 'Wohi sheher — roots important' },
        contributions: { geography: 0.8, family: 0.3 },
      },
      {
        id: 'b',
        label: { en: 'Different Pakistani city for opportunity', ur: 'پاکستان کا دوسرا شہر', ro_ur: 'Pakistan ka dusra sheher' },
        contributions: { geography: 0.2, career: 0.3 },
      },
      {
        id: 'c',
        label: { en: 'Gulf / Middle East', ur: 'خلیجی ممالک', ro_ur: 'Gulf countries' },
        contributions: { geography: -0.4, finances: 0.5 },
      },
      {
        id: 'd',
        label: { en: 'UK / North America', ur: 'برطانیہ یا شمالی امریکہ', ro_ur: 'UK ya North America' },
        contributions: { geography: -0.8, career: 0.4 },
      },
    ],
  },

  // ---------- 8. Deen: hijab / beard expectation ----------
  {
    id: 'card_appearance',
    title: { en: 'Deen and appearance', ur: 'دین اور ظاہری حلیہ', ro_ur: 'Deen aur appearance' },
    prompt: {
      en: 'For your spouse, what would you expect in terms of hijab / beard?',
      ur: 'شریکِ حیات سے حجاب/داڑھی کے بارے میں آپ کی توقع؟',
      ro_ur: 'Partner se hijab/beard ki expectation?',
    },
    options: [
      {
        id: 'a',
        label: { en: 'Full observance from day one', ur: 'پہلے دن سے مکمل پابندی', ro_ur: 'Day one se observance' },
        contributions: { deen: 0.8 },
      },
      {
        id: 'b',
        label: { en: 'Practicing but flexible — let it grow', ur: 'دین دار مگر لچک', ro_ur: 'Practicing magar flexible' },
        contributions: { deen: 0.3 },
      },
      {
        id: 'c',
        label: { en: 'Up to them — I do not impose', ur: 'ان کی مرضی', ro_ur: 'Unki marzi' },
        contributions: { deen: -0.2 },
      },
      {
        id: 'd',
        label: { en: 'Prefer modern dress, no expectations', ur: 'جدید لباس بہتر', ro_ur: 'Modern dress prefer' },
        contributions: { deen: -0.7 },
      },
    ],
  },

  // ---------- 9. Family loyalty: parents needing care ----------
  {
    id: 'card_parents_care',
    title: { en: 'Aging parents', ur: 'بزرگ والدین', ro_ur: 'Buzurg waldain' },
    prompt: {
      en: 'A parent needs daily care. What does your household do?',
      ur: 'والد/والدہ کو روزانہ دیکھ بھال چاہیے۔ آپ کا فیصلہ؟',
      ro_ur: 'Waldain ko daily care chahiye — kya karenge?',
    },
    options: [
      {
        id: 'a',
        label: { en: 'They move in with us', ur: 'وہ ہمارے ساتھ آ جائیں', ro_ur: 'Wo hamare sath aa jayein' },
        contributions: { family: 0.8 },
      },
      {
        id: 'b',
        label: { en: 'We move closer to them', ur: 'ہم ان کے قریب چلے جائیں', ro_ur: 'Hum unke qareeb shift' },
        contributions: { family: 0.5, geography: -0.3 },
      },
      {
        id: 'c',
        label: { en: 'Hired help + frequent visits', ur: 'تنخواہ دار خدمت + اکثر ملاقات', ro_ur: 'Hired help + visits' },
        contributions: { family: 0.0, finances: 0.3 },
      },
      {
        id: 'd',
        label: { en: 'Siblings share the load', ur: 'بہن بھائی مل کر', ro_ur: 'Siblings divide kar lein' },
        contributions: { family: 0.2 },
      },
    ],
  },

  // ---------- 10. Career: ambition of spouse ----------
  {
    id: 'card_ambition',
    title: { en: 'Spouse ambition', ur: 'شریک حیات کی خواہش', ro_ur: 'Partner ki ambition' },
    prompt: {
      en: 'Which describes the spouse you want?',
      ur: 'آپ کس قسم کے شریک حیات چاہتے ہیں؟',
      ro_ur: 'Aap kis tarah ka partner chahte hain?',
    },
    options: [
      {
        id: 'a',
        label: { en: 'High-achiever — top of their field', ur: 'بلند پرواز پیشہ ور', ro_ur: 'High-achiever, top of field' },
        contributions: { career: 0.8 },
      },
      {
        id: 'b',
        label: { en: 'Stable career, predictable life', ur: 'مستحکم پیشہ، متوازن زندگی', ro_ur: 'Stable career, balanced life' },
        contributions: { career: 0.2 },
      },
      {
        id: 'c',
        label: { en: 'Family-focused, career secondary', ur: 'خاندان پر توجہ، کیریئر بعد میں', ro_ur: 'Family focus, career baad mein' },
        contributions: { career: -0.6, family: 0.5 },
      },
    ],
  },

  // ---------- 11. Finances: division of money ----------
  {
    id: 'card_finances_split',
    title: { en: 'Money in the household', ur: 'گھر کی معاشیات', ro_ur: 'Ghar ki maaliyat' },
    prompt: {
      en: 'How should household money be structured?',
      ur: 'گھر کے پیسوں کا انتظام کیسے ہو؟',
      ro_ur: 'Ghar ke paisay ka system kya ho?',
    },
    options: [
      {
        id: 'a',
        label: { en: 'One joint account, full transparency', ur: 'ایک مشترکہ اکاؤنٹ', ro_ur: 'Aik joint account' },
        contributions: { finances: -0.2, conflict: 0.3 },
      },
      {
        id: 'b',
        label: { en: 'Husband handles primary, wife has discretion', ur: 'بنیادی اخراجات شوہر، باقی بیوی پر', ro_ur: 'Primary husband, baqi wife' },
        contributions: { finances: 0.0, family: 0.3 },
      },
      {
        id: 'c',
        label: { en: 'Both contribute proportional to income', ur: 'دونوں اپنی آمدنی کے مطابق', ro_ur: 'Dono apni income ke hisaab se' },
        contributions: { career: 0.5, finances: 0.2 },
      },
      {
        id: 'd',
        label: { en: 'Separate finances, agreed shared bills', ur: 'الگ پیسے، طے شدہ مشترکہ بل', ro_ur: 'Alag paisay, shared bills' },
        contributions: { career: 0.3, family: -0.3 },
      },
    ],
  },

  // ---------- 12. Dealbreakers / past relationships ----------
  {
    id: 'card_past',
    title: { en: 'Past relationships', ur: 'ماضی کے تعلقات', ro_ur: 'Maazi ke ta’alluqat' },
    prompt: {
      en: 'A match has a public past relationship that ended cleanly. How does this land?',
      ur: 'کسی پارٹنر کا ماضی میں عوامی تعلق رہا جو خوش اسلوبی سے ختم ہوا۔ آپ کا رد عمل؟',
      ro_ur: 'Partner ka past mein public relationship raha, cleanly khatam — aap ka reaction?',
    },
    options: [
      {
        id: 'a',
        label: { en: 'Not a problem if they are honest', ur: 'ایمانداری ہو تو مسئلہ نہیں', ro_ur: 'Honest hon to no issue' },
        contributions: { dealbreakers: -0.6 },
      },
      {
        id: 'b',
        label: { en: 'I would want to understand context first', ur: 'پہلے سیاق و سباق سمجھنا چاہوں گا', ro_ur: 'Pehle context samajhna chahunga' },
        contributions: { dealbreakers: -0.2, conflict: 0.3 },
      },
      {
        id: 'c',
        label: { en: 'Prefer no prior relationships', ur: 'پہلے کوئی تعلق نہ ہو', ro_ur: 'Pehle koi relationship na ho' },
        contributions: { dealbreakers: 0.5 },
      },
      {
        id: 'd',
        label: { en: 'Absolute dealbreaker', ur: 'مطلقاً انکار', ro_ur: 'Bilkul nahi' },
        contributions: { dealbreakers: 0.9 },
      },
    ],
  },
] as const;

if (SCENARIO_CARDS.length !== 12) {
  throw new Error(`MASTERPLAN §8.1 requires 12 scenario cards, have ${SCENARIO_CARDS.length}`);
}

export function getCard(cardId: string): ScenarioCard | undefined {
  return SCENARIO_CARDS.find((c) => c.id === cardId);
}

export function getOption(card: ScenarioCard, optionId: string): ScenarioOption | undefined {
  return card.options.find((o) => o.id === optionId);
}
