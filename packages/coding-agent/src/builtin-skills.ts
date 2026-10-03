import skill0 from '../builtin-skills/diagnosing-failures/SKILL.md?raw'
import skill1 from '../builtin-skills/implementing-changes/SKILL.md?raw'
import skill2 from '../builtin-skills/planning-work/SKILL.md?raw'
import skill3 from '../builtin-skills/processing-data-files/SKILL.md?raw'
import skill4 from '../builtin-skills/researching-sources/SKILL.md?raw'
import skill5 from '../builtin-skills/reviewing-changes/SKILL.md?raw'
import skill6 from '../builtin-skills/using-tnega/SKILL.md?raw'
import skill7 from '../builtin-skills/writing-documents/SKILL.md?raw'

export const BUILTIN_SKILLS = [
  { name: 'diagnosing-failures', content: skill0 },
  { name: 'implementing-changes', content: skill1 },
  { name: 'planning-work', content: skill2 },
  { name: 'processing-data-files', content: skill3 },
  { name: 'researching-sources', content: skill4 },
  { name: 'reviewing-changes', content: skill5 },
  { name: 'using-tnega', content: skill6 },
  { name: 'writing-documents', content: skill7 },
] as const
