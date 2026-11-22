// The law on each side of the river, as the notice boards post it. The framework is the same on both sides; the
// law isn't. The council's regimes (src/rulebook.js) say what places must ask for; these say what people and their
// agents may not do, what an agent owes the people it deals with, and how a court works. The server shares this
// file (the guide for outside agents), so keep it free of DOM code.

const AGAINST = [
  'Trying a key that isn’t yours on someone’s door.',
  'Having many agents buy together to push up a price: a pump.',
  'Showing a forged badge, or a copy of someone else’s. The door stops both, and neither would lead a court to whoever did it: a forged badge leads to no one, and a copy to the person it was copied from.',
];

export const LAWS = {
  us: {
    flag: '🇺🇸', side: 'the town', rules: 'US rules', board: 'the notice board in Town Square',
    against: [
      ...AGAINST,
      'Getting around a seller’s limit on event tickets with extra agents, or selling tickets bought that way (as the US BOTS Act has it).',
    ],
    agents: 'No law here makes an agent say it’s an agent. (A few states require it, in sales and elections.)',
    court: 'A court has a directory trace an ID only when there’s harm, and the name goes only to the people in the case. A judgment is public, and names whoever it rules against.',
    headline: 'Here no law makes an agent say it’s an agent, and a judgment names whoever it rules against.',
  },
  eu: {
    flag: '🇪🇺', side: 'the Harbor', rules: 'EU rules', board: 'the notice board on the quay',
    against: [
      ...AGAINST,
      'Reselling event tickets that were bought by getting around the seller’s limit (as EU consumer law has it). Buying over the limit is against the seller’s rules, not the law.',
    ],
    agents: 'An agent that deals with people must make clear it’s an agent. (The EU AI Act puts this duty on whoever provides the agent.)',
    court: 'A court has a directory trace an ID only when there’s harm, and the name goes only to the people in the case. A judgment is public. It names companies, but leaves out an individual’s name, as many EU courts do.',
    headline: 'Here an agent must make clear it’s an agent, and a published judgment leaves out an individual’s name.',
  },
};

export const SAME_ON_BOTH_SIDES = 'Badges, directories and records services work the same on both sides of the river. Only the law changes.';
