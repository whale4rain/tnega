import skill0 from '../builtin-skills/ddd/SKILL.md?raw'
import skill1 from '../builtin-skills/diagnosing-failures/SKILL.md?raw'
import skill2 from '../builtin-skills/implementing-changes/SKILL.md?raw'
import skill3 from '../builtin-skills/planning-work/SKILL.md?raw'
import skill4 from '../builtin-skills/processing-data-files/SKILL.md?raw'
import skill5 from '../builtin-skills/researching-sources/SKILL.md?raw'
import skill6 from '../builtin-skills/reviewing-changes/SKILL.md?raw'
import skill7 from '../builtin-skills/skill-create/SKILL.md?raw'
import skill8 from '../builtin-skills/skill-install/SKILL.md?raw'
import skill9 from '../builtin-skills/tdd/SKILL.md?raw'
import skill10 from '../builtin-skills/using-tnega/SKILL.md?raw'
import skill11 from '../builtin-skills/writing-documents/SKILL.md?raw'

export const BUILTIN_SKILLS = [
  { name: 'ddd', content: skill0 },
  { name: 'diagnosing-failures', content: skill1 },
  { name: 'implementing-changes', content: skill2 },
  { name: 'planning-work', content: skill3 },
  { name: 'processing-data-files', content: skill4 },
  { name: 'researching-sources', content: skill5 },
  { name: 'reviewing-changes', content: skill6 },
  { name: 'skill-create', content: skill7 },
  { name: 'skill-install', content: skill8 },
  { name: 'tdd', content: skill9 },
  { name: 'using-tnega', content: skill10 },
  { name: 'writing-documents', content: skill11 },
] as const
