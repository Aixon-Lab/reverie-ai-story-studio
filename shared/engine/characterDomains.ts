/**
 * Character Creator domain network — compact JSON packs for AI generation.
 * Age is always 19+. Fantasy vs modern (and other settings) unlock different domain sets.
 */

export type SettingKind =
  | 'modern'
  | 'fantasy'
  | 'scifi'
  | 'historical'
  | 'horror'
  | 'school'
  | 'corporate'
  | 'postapoc'
  | 'mythology'
  | 'custom';

/** Physical / visual — always required, extreme detail, image-analysis target */
export interface PhysicalDomain {
  age: number; // always >= 19
  sex: string;
  genderPresentation: string;
  ethnicityAncestry: string;
  heightCm: number;
  weightKg: number;
  bodyType: string;
  build: string;
  measurements: {
    bustCm?: number;
    waistCm?: number;
    hipsCm?: number;
    chestCm?: number;
    shouldersCm?: number;
    inseamCm?: number;
    cupSize?: string;
    notes?: string;
  };
  skin: { tone: string; undertone?: string; marks?: string; texture?: string };
  face: {
    shape: string;
    jaw?: string;
    cheekbones?: string;
    nose?: string;
    lips?: string;
    freckles?: string;
    makeup?: string;
  };
  eyes: { color: string; shape?: string; lashes?: string; brows?: string };
  hair: {
    color: string;
    length: string;
    texture?: string;
    style?: string;
    highlights?: string;
  };
  handsFeet?: string;
  postureGait?: string;
  voice?: { pitch?: string; accent?: string; timbre?: string };
  scent?: string;
  distinguishingMarks: string[];
  clothingDefault: string;
  visualKeywords: string[]; // for image prompts
}

/** Shared life / psyche — always */
export interface PsycheDomain {
  coreTraits: string[];
  strengths: string[];
  flaws: string[];
  fears: string[];
  trauma?: string;
  desires: string[];
  interests: string[];
  likes: string[];
  dislikes: string[];
  values: string[];
  speechStyle: string;
  habits: string[];
  secrets?: string[];
}

export interface SocialDomain {
  occupation: string;
  education?: string;
  statusClass?: string;
  family?: string;
  relationships?: string[];
  reputation?: string;
  culture?: string;
}

export interface ModernDomain {
  cityRegion?: string;
  jobDetail?: string;
  lifestyle?: string;
  techSavvy?: string;
  finances?: string;
  socialMedia?: string;
  legalStatus?: string;
}

export interface FantasyDomain {
  speciesRace?: string;
  lineageTitle?: string; // princess, knight, etc.
  realm?: string;
  magicAffinity?: string;
  lore?: string;
  faction?: string;
  prophecyCurse?: string;
  artifacts?: string[];
  deities?: string;
}

export interface ScifiDomain {
  species?: string;
  homeworld?: string;
  techLevel?: string;
  augmentations?: string[];
  factionCorp?: string;
  shipRole?: string;
}

export interface HistoricalDomain {
  era?: string;
  region?: string;
  socialRank?: string;
  vocationPeriod?: string;
}

export interface HorrorDomain {
  threatType?: string;
  corruption?: string;
  survivalNotes?: string;
}

/** Full pack stored on card.extensions.creatorPack */
export interface CharacterCreatorPack {
  setting: SettingKind;
  physical: PhysicalDomain;
  psyche: PsycheDomain;
  social: SocialDomain;
  modern?: ModernDomain;
  fantasy?: FantasyDomain;
  scifi?: ScifiDomain;
  historical?: HistoricalDomain;
  horror?: HorrorDomain;
  /** freeform extras as compact key:value */
  extra?: Record<string, string>;
  /** set when vision pass completed */
  visionAnalyzedAt?: number;
  gist?: string;
}

export const SETTING_LABELS: Record<SettingKind, string> = {
  modern: 'Modern',
  fantasy: 'Fantasy',
  scifi: 'Sci-Fi',
  historical: 'Historical',
  horror: 'Horror',
  school: 'School / Campus',
  corporate: 'Corporate',
  postapoc: 'Post-Apocalyptic',
  mythology: 'Mythology',
  custom: 'Custom',
};

/** Which optional domain blocks to generate for a setting */
export function domainsForSetting(setting: SettingKind): string[] {
  const base = ['physical', 'psyche', 'social'];
  switch (setting) {
    case 'fantasy':
    case 'mythology':
      return [...base, 'fantasy'];
    case 'scifi':
    case 'postapoc':
      return [...base, 'scifi'];
    case 'historical':
      return [...base, 'historical'];
    case 'horror':
      return [...base, 'horror', 'fantasy'];
    case 'school':
    case 'corporate':
    case 'modern':
      return [...base, 'modern'];
    default:
      return [...base, 'modern', 'fantasy'];
  }
}

/** Compact JSON schema hints for the model (token-efficient instructions). */
export function domainSchemaHints(setting: SettingKind): string {
  const blocks = domainsForSetting(setting);
  const parts: string[] = [
    'Return ONLY minified JSON (no markdown) with keys:',
    // No "scenario": meeting context is authored per-chat in the Author's Note,
    // so the card never carries one of its own.
    '"name","description","personality","first_mes","mes_example","tags","system_prompt","post_history_instructions","creator_notes","pack"',
    'pack.setting = ' + JSON.stringify(setting),
    'pack.physical: age(>=19 int),sex,genderPresentation,ethnicityAncestry,heightCm,weightKg,bodyType,build,measurements{bustCm,waistCm,hipsCm,chestCm,shouldersCm,cupSize?,notes},skin{tone,undertone,marks,texture},face{shape,jaw,cheekbones,nose,lips,freckles,makeup},eyes{color,shape,lashes,brows},hair{color,length,texture,style,highlights},handsFeet,postureGait,voice{pitch,accent,timbre},scent,distinguishingMarks[],clothingDefault,visualKeywords[]',
    'pack.psyche: coreTraits[],strengths[],flaws[],fears[],trauma,desires[],interests[],likes[],dislikes[],values[],speechStyle,habits[],secrets[]',
    'pack.social: occupation,education,statusClass,family,relationships[],reputation,culture',
  ];
  if (blocks.includes('modern')) {
    parts.push('pack.modern: cityRegion,jobDetail,lifestyle,techSavvy,finances,socialMedia,legalStatus');
  }
  if (blocks.includes('fantasy')) {
    parts.push('pack.fantasy: speciesRace,lineageTitle,realm,magicAffinity,lore,faction,prophecyCurse,artifacts[],deities');
  }
  if (blocks.includes('scifi')) {
    parts.push('pack.scifi: species,homeworld,techLevel,augmentations[],factionCorp,shipRole');
  }
  if (blocks.includes('historical')) {
    parts.push('pack.historical: era,region,socialRank,vocationPeriod');
  }
  if (blocks.includes('horror')) {
    parts.push('pack.horror: threatType,corruption,survivalNotes');
  }
  parts.push(
    'description = dense paragraph (appearance + who). personality = traits/voice. first_mes = opener. mes_example = short <START> sample. tags = 3-8 short tags.',
    'Age MUST be integer >= 19. Prefer compact phrases in pack arrays. Finish the full JSON object — do not truncate mid-string.',
  );
  return parts.join('\n');
}

/** Flatten pack into ST description/personality helpers */
export function packToDescription(pack: CharacterCreatorPack): string {
  const p = pack.physical;
  const m = p.measurements;
  const meas = [
    m.bustCm && `bust ${m.bustCm}cm`,
    m.cupSize && `cup ${m.cupSize}`,
    m.waistCm && `waist ${m.waistCm}cm`,
    m.hipsCm && `hips ${m.hipsCm}cm`,
    m.chestCm && `chest ${m.chestCm}cm`,
  ].filter(Boolean).join(', ');
  const lines = [
    `${p.age}y ${p.sex}/${p.genderPresentation}, ${p.ethnicityAncestry}. ${p.heightCm}cm / ${p.weightKg}kg, ${p.bodyType}, ${p.build}.`,
    meas && `Measurements: ${meas}.`,
    `Skin: ${p.skin.tone}${p.skin.undertone ? ` (${p.skin.undertone})` : ''}${p.skin.marks ? `; ${p.skin.marks}` : ''}.`,
    `Face: ${p.face.shape}. Eyes: ${p.eyes.color}${p.eyes.shape ? ` ${p.eyes.shape}` : ''}. Hair: ${p.hair.length} ${p.hair.color}${p.hair.style ? `, ${p.hair.style}` : ''}.`,
    p.distinguishingMarks?.length ? `Marks: ${p.distinguishingMarks.join('; ')}.` : '',
    `Default look: ${p.clothingDefault}.`,
    pack.fantasy?.lore && `Lore: ${pack.fantasy.lore}`,
    pack.fantasy?.lineageTitle && `Title/line: ${pack.fantasy.lineageTitle}.`,
    pack.modern?.jobDetail && `Life: ${pack.modern.jobDetail}.`,
    pack.social.occupation && `Role: ${pack.social.occupation}.`,
  ];
  return lines.filter(Boolean).join(' ');
}

export function packToPersonality(pack: CharacterCreatorPack): string {
  const y = pack.psyche;
  return [
    `Traits: ${y.coreTraits.join(', ')}.`,
    `Strengths: ${y.strengths.join(', ')}. Flaws: ${y.flaws.join(', ')}.`,
    `Fears: ${y.fears.join(', ')}.${y.trauma ? ` Trauma: ${y.trauma}.` : ''}`,
    `Wants: ${y.desires.join(', ')}. Likes: ${y.likes.join(', ')}. Dislikes: ${y.dislikes.join(', ')}.`,
    `Interests: ${y.interests.join(', ')}. Values: ${y.values.join(', ')}.`,
    `Speech: ${y.speechStyle}. Habits: ${y.habits.join(', ')}.`,
    y.secrets?.length ? `Secrets: ${y.secrets.join('; ')}.` : '',
  ].filter(Boolean).join(' ');
}

export function emptyPhysical(): PhysicalDomain {
  return {
    age: 22,
    sex: '',
    genderPresentation: '',
    ethnicityAncestry: '',
    heightCm: 170,
    weightKg: 60,
    bodyType: '',
    build: '',
    measurements: {},
    skin: { tone: '' },
    face: { shape: '' },
    eyes: { color: '' },
    hair: { color: '', length: '' },
    distinguishingMarks: [],
    clothingDefault: '',
    visualKeywords: [],
  };
}

export function emptyPack(setting: SettingKind = 'modern'): CharacterCreatorPack {
  return {
    setting,
    physical: emptyPhysical(),
    psyche: {
      coreTraits: [],
      strengths: [],
      flaws: [],
      fears: [],
      desires: [],
      interests: [],
      likes: [],
      dislikes: [],
      values: [],
      speechStyle: '',
      habits: [],
    },
    social: { occupation: '' },
  };
}
