import { useEffect, useState, type ReactNode } from 'react'
import { Badge } from '@astryxdesign/core/Badge'
import { AppShell } from '@astryxdesign/core/AppShell'
import { Heading } from '@astryxdesign/core/Heading'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Layout, LayoutContent, LayoutPanel } from '@astryxdesign/core/Layout'
import {
  SideNav,
  SideNavCollapseButton,
} from '@astryxdesign/core/SideNav'
import { Text } from '@astryxdesign/core/Text'
import { TopNav, TopNavHeading } from '@astryxdesign/core/TopNav'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { Code2, Files, GitBranch, PanelLeft, Terminal, X } from 'lucide-react'

const tools = [
  {
    id: 'files',
    title: 'Files',
    icon: Files,
    description: 'Browse workspace files alongside your conversation.',
  },
  {
    id: 'changes',
    title: 'Changes',
    icon: GitBranch,
    description: 'Review agent changes and diffs here.',
  },
  {
    id: 'terminal',
    title: 'Terminal',
    icon: Terminal,
    description: 'Inspect command output without leaving your conversation.',
  },
] as const

export function WorkbenchShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem('tnega-sidebar')
    return stored ? stored !== 'closed' : window.innerWidth > 760
  })
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const tool = tools.find((item) => item.id === activeTool)
  const collapsible = {
    isCollapsed: !open,
    onCollapsedChange: (isCollapsed: boolean) => setOpen(!isCollapsed),
    hasButton: false,
  }

  useEffect(() => {
    localStorage.setItem('tnega-sidebar', open ? 'open' : 'closed')
  }, [open])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setActiveTool(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <AppShell
      className="tnega-app-shell"
      variant="surface"
      contentPadding={0}
      height="fill"
      topNav={
        <TopNav
          label="Application navigation"
          heading={
            <TopNavHeading
              heading="Tnega"
              logo={<Code2 size={18} aria-hidden="true" />}
            />
          }
          endContent={
            <>
              <Text color="secondary" size="sm">Code</Text>
              <Tooltip content={open ? 'Collapse sidebar' : 'Expand sidebar'}>
                <SideNavCollapseButton
                  collapsible={collapsible}
                  aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
                  aria-expanded={open}
                  aria-controls="workspace-navigation"
                >
                  <PanelLeft size={16} aria-hidden="true" />
                </SideNavCollapseButton>
              </Tooltip>
            </>
          }
        />
      }
      sideNav={
        <SideNav
          className={`tnega-side-nav${open ? '' : ' is-collapsed'}`}
          id="workspace-navigation"
          aria-label="Workspace navigation"
          collapsible={collapsible}
        >
          {sidebar}
        </SideNav>
      }
    >
      <Layout
        className="tnega-workbench-layout"
        content={<LayoutContent padding={0}>{children}</LayoutContent>}
        end={
          <LayoutPanel
            className="tnega-tools-panel"
            width={tool ? 320 : 56}
            padding={1}
            role="complementary"
            label="Workspace tools"
          >
            <nav className="tnega-tools-rail" aria-label="Workspace tools">
              {tools.map((item) => (
                <Tooltip content={item.title} key={item.id}>
                  <IconButton
                    variant={activeTool === item.id ? 'primary' : 'ghost'}
                    label={`Toggle ${item.title}`}
                    aria-pressed={activeTool === item.id}
                    icon={<item.icon size={18} aria-hidden="true" />}
                    onClick={() =>
                      setActiveTool(activeTool === item.id ? null : item.id)
                    }
                  />
                </Tooltip>
              ))}
            </nav>
            {tool && (
              <section className="tnega-tool-content" aria-label={`${tool.title} panel`}>
                <header className="tnega-tool-heading">
                  <Heading level={2}>{tool.title}</Heading>
                  <IconButton
                    variant="ghost"
                    label="Close tools panel"
                    icon={<X size={14} aria-hidden="true" />}
                    onClick={() => setActiveTool(null)}
                  />
                </header>
                <section className="tnega-tool-placeholder">
                  <tool.icon size={32} strokeWidth={1.2} aria-hidden="true" />
                  <Heading level={3}>{tool.title}</Heading>
                  <Text color="secondary">{tool.description}</Text>
                  <Badge label="Coming soon" />
                  <Text color="secondary" size="sm">
                    This panel is a placeholder. No tools are connected yet.
                  </Text>
                </section>
              </section>
            )}
          </LayoutPanel>
        }
      />
    </AppShell>
  )
}
