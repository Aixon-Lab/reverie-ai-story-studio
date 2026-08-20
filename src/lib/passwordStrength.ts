/**
 * Rough passphrase strength meter (0–4).
 *
 * Deliberately entropy-flavoured rather than "did you use a symbol?" — length
 * and variety of independent words is what actually costs an attacker, and the
 * scrypt cost factor multiplies whatever entropy is here. This is UI guidance
 * only; the server enforces nothing beyond a minimum length.
 */
export interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  bits: number;
}

const COMMON = [
  'password', 'passw0rd', '123456', '12345678', 'qwerty', 'letmein', 'welcome',
  'admin', 'iloveyou', 'monkey', 'dragon', 'abc123', 'reverie', 'sillytavern',
];

export function passwordStrength(pw: string): Strength {
  if (!pw) return { score: 0, label: 'Too short', bits: 0 };

  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;

  // Repeated characters add far less than their length suggests.
  const unique = new Set(pw).size;
  const effective = pw.length * Math.min(1, 0.35 + unique / pw.length);
  let bits = Math.round(effective * Math.log2(Math.max(pool, 2)));

  const lower = pw.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) bits = Math.min(bits, 24);
  if (/^(.)\1+$/.test(pw)) bits = Math.min(bits, 8);

  // A multi-word passphrase is credited for its words, not its character soup.
  const words = pw.trim().split(/[\s._-]+/).filter((w) => w.length > 2);
  if (words.length >= 3) bits = Math.max(bits, words.length * 12);

  if (pw.length < 8) return { score: 0, label: 'Too short', bits };
  if (bits < 45) return { score: 1, label: 'Weak — crackable offline', bits };
  if (bits < 65) return { score: 2, label: 'Fair', bits };
  if (bits < 90) return { score: 3, label: 'Strong', bits };
  return { score: 4, label: 'Excellent', bits };
}
