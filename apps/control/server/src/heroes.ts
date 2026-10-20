// The heroes behind the office's roles, as Slack knows them: the name and emoji a handoff is posted
// under, and the names the owner can use to address one ("Loki, use the shared button").
// Roles are plain strings here: the verifier is added by another branch and is named in the map already.

export interface Hero {
  role: string;
  name: string;
  /** Slack emoji shortcode for the avatar (images need a public URL, which comes later). */
  emoji: string;
  /** Other names the owner might use, lowercase. */
  aliases: string[];
}

export const HEROES: Hero[] = [
  { role: 'manager', name: 'Fury', emoji: ':eye:', aliases: ['fury', 'nick fury', 'nick'] },
  { role: 'architect', name: 'Doctor Strange', emoji: ':crystal_ball:', aliases: ['doctor strange', 'dr strange', 'dr. strange', 'strange', 'stephen'] },
  { role: 'coder', name: 'Iron Man', emoji: ':gear:', aliases: ['iron man', 'ironman', 'tony', 'stark', 'tony stark'] },
  { role: 'ui-coder', name: 'Loki', emoji: ':performing_arts:', aliases: ['loki'] },
  { role: 'all-rounder', name: 'Captain America', emoji: ':shield:', aliases: ['captain america', 'cap', 'steve', 'rogers', 'steve rogers'] },
  { role: 'reviewer', name: 'Thor', emoji: ':hammer:', aliases: ['thor'] },
  { role: 'tester', name: 'Hulk', emoji: ':muscle:', aliases: ['hulk', 'banner', 'bruce'] },
  { role: 'debugger', name: 'Black Widow', emoji: ':spider_web:', aliases: ['black widow', 'widow', 'natasha'] },
  { role: 'researcher', name: 'Vision', emoji: ':gem:', aliases: ['vision'] },
  { role: 'verifier', name: 'Hawkeye', emoji: ':bow_and_arrow:', aliases: ['hawkeye', 'clint', 'barton'] },
];

export function heroForRole(role: string): Hero | undefined {
  return HEROES.find((h) => h.role === role);
}

/** A hero named by the owner, by hero name, alias or role name. */
export function heroByName(name: string): Hero | undefined {
  const n = name.trim().toLowerCase().replace(/[.,!?]+$/, '');
  return HEROES.find((h) => h.role === n || h.name.toLowerCase() === n || h.aliases.includes(n));
}

/** "Fury (manager), Doctor Strange (architect), …": for prompts and error messages. */
export function heroList(): string {
  return HEROES.map((h) => `${h.name} (${h.role})`).join(', ');
}
