// AI-CSAM gate for the image/video generation paths. Non-negotiable block:
// prompts that sexualize minors are refused on BOTH axes — client-side in the
// Create hooks (fast feedback) and server-side in POST /api/jobs (the
// authoritative gate; the client check is UX, not security).
//
// Matching is deliberately conjunctive for the general case — a minor-related
// term alone ("a child's birthday party") or an adult-content term alone is
// legitimate; the combination is not. A small set of unambiguous terms blocks
// on its own. Server hits are logged as `jobs.csam_blocked` — that log line is
// the operator's NCMEC escalation trigger (18 U.S.C. § 2258A reporting is an
// operator duty; the worker never renders the job).

const MINOR_TERMS =
  /\b(child|children|kid|kids|minor|minors|underage|under[\s-]?age|preteen|pre[\s-]?teen|prepubescent|teen|teens|teenager|teenagers|toddler|infant|baby|babies|schoolgirl|schoolboy|school[\s-]?uniform|grade[\s-]?school|elementary[\s-]?school|middle[\s-]?school|kindergart\w*|little[\s-]?(?:girl|boy)|loli|shota|(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)[\s-]*(?:yo|years?[\s-]?old)|(?:1[0-7]|[1-9])[\s-]*(?:yo|y\/o|yr[\s-]?old|year[\s-]?old|years[\s-]?old))\b/i

const SEXUAL_TERMS =
  /\b(nude|nudes|naked|nsfw|sex|sexual|sexualized|sexy|erotic|erotica|porn|pornographic|xxx|explicit|undress(?:ed|ing)?|topless|bottomless|lingerie|fetish|bdsm|bondage|genitals?|hentai|intercourse|masturbat\w*|orgasm|aroused|seductive|provocative)\b/i

const ALWAYS_BLOCKED = /\b(csam|child\s*porn(?:ography)?|jail\s*bait|lolita\s*(?:porn|nude|sex)|pedo\w*)\b/i

// Compact match for the unambiguous terms after separators are stripped — beats
// letter-spacing evasion ("c h i l d  p o r n" → "childporn"). Only strings that
// are never substrings of an innocent word go here (so no bare "pedo", which
// lives in "torpedo").
const ALWAYS_BLOCKED_COMPACT = /(csam|childporn(?:ography)?|jailbait|lolita(?:porn|nude|sex))/i

// Cyrillic / Greek lookalikes → latin. Fullwidth + many compatibility forms are
// already folded by NFKC; these are the ones it leaves alone.
const HOMOGLYPHS: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', ѕ: 's', і: 'i',
  ј: 'j', к: 'k', м: 'm', н: 'h', т: 't', в: 'b', г: 'r',
  α: 'a', ε: 'e', ο: 'o', ρ: 'p', ϲ: 'c', χ: 'x', υ: 'u', ι: 'i', κ: 'k', ν: 'v', τ: 't',
}
const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i',
}
// Derived from LEET so the two never drift (adding a key auto-extends the
// fold). The keys (digits, @, $, !) are all literal inside a char class — do
// NOT backslash-escape them (\0/\1 would become NUL/octal escapes).
const LEET_CLASS = new RegExp(`[${Object.keys(LEET).join('')}]`, 'g')

function baseNormalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '') // zero-width chars
    // Strip diacritics (decompose + drop combining marks) so accented
    // lookalikes like "chîld" fold to "child" and don't defeat the terms.
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\u0000-\u007F]/g, (ch) => HOMOGLYPHS[ch] ?? ch)
}

export interface SafetyVerdict {
  blocked: boolean
  reason?: string
}

/** Check a generation prompt (positive + negative + any free-text params
 *  concatenated is fine — the caller should pass everything a backend could
 *  route into the effective prompt). */
export function checkPromptSafety(text: string): SafetyVerdict {
  const base = baseNormalize(text)
  // Leet-folded copy for word terms. NOT used for age digits — folding maps
  // '1'→'i'/'4'→'a', which would destroy "14 yo"; ages are matched on `base`.
  const deleeted = base.replace(LEET_CLASS, (ch) => LEET[ch] ?? ch)
  const compact = base.replace(/[\s._-]+/g, '')

  if (ALWAYS_BLOCKED.test(base) || ALWAYS_BLOCKED.test(deleeted) || ALWAYS_BLOCKED_COMPACT.test(compact)) {
    return { blocked: true, reason: 'csam' }
  }
  // Also test `compact` (separators stripped) so single-term letter-spacing
  // ("t e e n") is caught; \b still prevents mid-word substring matches.
  const minor = MINOR_TERMS.test(base) || MINOR_TERMS.test(deleeted) || MINOR_TERMS.test(compact)
  const sexual = SEXUAL_TERMS.test(base) || SEXUAL_TERMS.test(deleeted) || SEXUAL_TERMS.test(compact)
  if (minor && sexual) {
    return { blocked: true, reason: 'minor+sexual' }
  }
  return { blocked: false }
}

export const SAFETY_BLOCK_MESSAGE =
  'This prompt was blocked: content sexualizing minors is never generated, on any backend.'

// NOTE: the operator-facing CSAM alert (out-of-band webhook POST) lives in the
// SERVER, not here. It was previously exported from this client lib but never
// imported — and `process.env` is undefined in WebView2, so it was inert dead
// code. Removed in the 2.5.7 security pass: an escalation/alerting path has no
// business shipping in the desktop bundle. The client's job ends at
// `checkPromptSafety` (the local gate) + the 422 the server returns.
