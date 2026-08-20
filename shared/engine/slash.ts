/** Minimal slash-command parser — ST-style `/command args`. */
export type SlashResult =
  | { kind: 'none'; text: string }
  | { kind: 'command'; name: string; args: string; raw: string };

export function parseSlash(input: string): SlashResult {
  const t = input.trim();
  if (!t.startsWith('/')) return { kind: 'none', text: input };
  // allow \/ escape for literal slash message
  if (t.startsWith('//')) return { kind: 'none', text: input.replace(/^\//, '') };
  const m = t.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return { kind: 'none', text: input };
  return { kind: 'command', name: m[1].toLowerCase(), args: (m[2] ?? '').trim(), raw: t };
}

export interface SlashContext {
  chatId: string;
  setInput: (s: string) => void;
  sendAsUser: (text: string) => Promise<void>;
  continueReply: () => Promise<void>;
  regenerate: () => Promise<void>;
  impersonate: () => Promise<void>;
  narrate: () => Promise<void>;
  setAuthorsNote: (text: string, depth?: number) => Promise<void>;
  setVariable: (key: string, value: string, global?: boolean) => Promise<void>;
  getVariable: (key: string, global?: boolean) => string;
  triggerSpeaker: (nameOrId: string) => Promise<void>;
  renameChat: (title: string) => Promise<void>;
  hideLast: () => Promise<void>;
  sys: (text: string) => Promise<void>;
}

export async function runSlash(cmd: Extract<SlashResult, { kind: 'command' }>, ctx: SlashContext): Promise<string | null> {
  const { name, args } = cmd;
  switch (name) {
    case 'help':
    case '?':
      return [
        'Commands: /help /continue /regen /impersonate /sys /note /setvar /getvar /setglobalvar',
        '/hide /narrator /go <char> /rename <title> /qr <label>',
        'Prefix message with // to send a literal slash line.',
      ].join('\n');
    case 'continue':
      await ctx.continueReply();
      return null;
    case 'regen':
    case 'regenerate':
      await ctx.regenerate();
      return null;
    case 'impersonate':
    case 'imp':
      await ctx.impersonate();
      return null;
    case 'sys':
    case 'system':
      if (!args) return 'Usage: /sys <message>';
      await ctx.sys(args);
      return null;
    case 'note':
    case 'an':
      await ctx.setAuthorsNote(args, 4);
      return args ? 'Author\'s note updated.' : 'Author\'s note cleared.';
    case 'setvar': {
      const i = args.indexOf(' ');
      if (i < 0) return 'Usage: /setvar name value';
      await ctx.setVariable(args.slice(0, i), args.slice(i + 1), false);
      return `Set {{${args.slice(0, i)}}}.`;
    }
    case 'getvar':
      return ctx.getVariable(args, false) || '(empty)';
    case 'setglobalvar': {
      const i = args.indexOf(' ');
      if (i < 0) return 'Usage: /setglobalvar name value';
      await ctx.setVariable(args.slice(0, i), args.slice(i + 1), true);
      return `Set global {{${args.slice(0, i)}}}.`;
    }
    case 'getglobalvar':
      return ctx.getVariable(args, true) || '(empty)';
    case 'hide':
      await ctx.hideLast();
      return 'Last message hidden from prompt.';
    case 'narrator':
    case 'narrate':
      await ctx.narrate();
      return null;
    case 'go':
    case 'trigger':
      if (!args) return 'Usage: /go <character name>';
      await ctx.triggerSpeaker(args);
      return null;
    case 'rename':
      if (!args) return 'Usage: /rename <title>';
      await ctx.renameChat(args);
      return `Renamed to “${args}”.`;
    case 'send':
      if (!args) return 'Usage: /send <text>';
      await ctx.sendAsUser(args);
      return null;
    default:
      return `Unknown command /${name}. Type /help.`;
  }
}
