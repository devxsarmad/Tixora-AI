import { Activity, Bot, CalendarDays, ChevronLeft, ChevronRight, CircleDot, LayoutDashboard, LogOut, Plus, Settings } from 'lucide-react';
import { getInitials } from '../../lib/formatters.js';
import { OrgSwitcher } from '../../components/layout/OrgSwitcher.js';
import tixoraLogo from '../../assests/tixora-logo.jpeg';
import { TixoraLoader } from '../../components/shared/TixoraLoader.js';
import type { AuthResponse } from '../auth/types.js';
import type { ProjectSummary } from '../projects/types.js';
import type { TeamDetail, TeamSummary } from '../organizations/types.js';
import type { SettingsSection } from '../settings/SettingsView.js';
import type { WorkspaceView } from './workspaceView.js';

type WorkspaceSidebarProps = {
  session: AuthResponse;
  teams: TeamSummary[];
  teamDetail: TeamDetail | null;
  selectedTeamSlug: string | null;
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  selectedProject: ProjectSummary | null;
  workspaceMemberCount: number;
  projectMemberCount: number;
  isResolvingProjects: boolean;
  includeArchivedProjects: boolean;
  isCollapsed: boolean;
  isOrgSwitcherOpen: boolean;
  activeView: WorkspaceView;
  activeSettingsSection: SettingsSection;
  onToggleCollapsed: () => void;
  onToggleOrgSwitcher: () => void;
  onSelectOrganization: (slug: string) => void;
  onCreateOrganization: () => void;
  onToggleProjectForm: () => void;
  onIncludeArchivedChange: (checked: boolean) => void;
  onSelectProject: (projectId: string) => void;
  onSelectView: (view: WorkspaceView) => void;
  onOpenOrganizationMembers: () => void;
  onOpenProjectMembers: () => void;
  onLogout: () => void;
};

export function WorkspaceSidebar({
  session,
  teams,
  teamDetail,
  selectedTeamSlug,
  projects,
  selectedProjectId,
  selectedProject,
  workspaceMemberCount,
  projectMemberCount,
  isResolvingProjects,
  includeArchivedProjects,
  isCollapsed,
  isOrgSwitcherOpen,
  activeView,
  activeSettingsSection,
  onToggleCollapsed,
  onToggleOrgSwitcher,
  onSelectOrganization,
  onCreateOrganization,
  onToggleProjectForm,
  onIncludeArchivedChange,
  onSelectProject,
  onSelectView,
  onOpenOrganizationMembers,
  onOpenProjectMembers,
  onLogout
}: WorkspaceSidebarProps) {
  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark logo-mark">
          <img src={tixoraLogo} alt="Tixora-AI logo" />
        </span>
        <strong>Tixora-AI</strong>
        <button
          type="button"
          className="icon-button sidebar-toggle"
          onClick={onToggleCollapsed}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {isCollapsed ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
        </button>
      </div>

      <OrgSwitcher
        teams={teams}
        selectedTeamSlug={selectedTeamSlug}
        isOpen={isOrgSwitcherOpen}
        onToggle={onToggleOrgSwitcher}
        onSelect={onSelectOrganization}
        onCreate={onCreateOrganization}
        getInitials={getInitials}
      />

      <section className="sidebar-section">
        <div className="sidebar-section-title"><span>Navigate</span></div>
        <nav className="sidebar-nav" aria-label="Workspace views">
          <button type="button" className={activeView === 'board' ? 'nav-item active' : 'nav-item'} onClick={() => onSelectView('board')}><span className="nav-icon"><LayoutDashboard aria-hidden="true" /></span><span className="nav-label">Board</span></button>
          <button type="button" className={activeView === 'my-tasks' ? 'nav-item active' : 'nav-item'} onClick={() => onSelectView('my-tasks')}><span className="nav-icon"><CircleDot aria-hidden="true" /></span><span className="nav-label">My tasks</span></button>
          <button type="button" className={activeView === 'calendar' ? 'nav-item active' : 'nav-item'} onClick={() => onSelectView('calendar')}><span className="nav-icon"><CalendarDays aria-hidden="true" /></span><span className="nav-label">Calendar</span></button>
          <button type="button" className={activeView === 'activity' ? 'nav-item active' : 'nav-item'} onClick={() => onSelectView('activity')}><span className="nav-icon"><Activity aria-hidden="true" /></span><span className="nav-label">Activity</span></button>
          <button type="button" className={activeView === 'ask' ? 'nav-item active' : 'nav-item'} onClick={() => onSelectView('ask')}><span className="nav-icon"><Bot aria-hidden="true" /></span><span className="nav-label">Ask Tixora</span></button>
          <button type="button" className={activeView === 'settings' && activeSettingsSection === 'profile' ? 'nav-item active' : 'nav-item'} onClick={() => onSelectView('settings')}><span className="nav-icon"><Settings aria-hidden="true" /></span><span className="nav-label">Settings</span></button>
        </nav>
      </section>

      <section className="sidebar-section">
        <div className="sidebar-section-title">
          <span>Projects</span>
          <button
            type="button"
            className="icon-button"
            disabled={!selectedTeamSlug || (teamDetail?.role !== 'owner' && teamDetail?.role !== 'admin')}
            onClick={onToggleProjectForm}
            aria-label="Create project"
          >
            <Plus aria-hidden="true" />
          </button>
        </div>
        <label className="check-row archive-toggle">
          <input
            type="checkbox"
            checked={includeArchivedProjects}
            onChange={(event) => onIncludeArchivedChange(event.target.checked)}
          />
          <span>Show archived</span>
        </label>
        <div className="sidebar-list">
          {isResolvingProjects ? (
            <div className="soft-empty sidebar-loader-row">
              <TixoraLoader variant="inline" label="Loading projects..." />
            </div>
          ) : null}
          {!isResolvingProjects && projects.length === 0 ? <div className="soft-empty">No projects yet.</div> : null}
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={
                project.id === selectedProjectId
                  ? 'sidebar-row project active'
                  : 'sidebar-row project'
              }
              onClick={() => onSelectProject(project.id)}
            >
              <span className="project-color" />
              <span>{project.name}</span>
              <small>{project.taskCount}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="sidebar-user">
        <span className="avatar">{getInitials(session.user.displayName)}</span>
        <div>
          <strong>{session.user.displayName}</strong>
          <p>{session.user.email}</p>
        </div>
        <button type="button" className="icon-button" onClick={() => onLogout()} aria-label="Log out"><LogOut aria-hidden="true" /></button>
      </div>
    </aside>
  );
}
