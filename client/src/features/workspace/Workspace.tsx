// Usage:
// Main authenticated workspace UI. Server state is loaded through feature-scoped
// React Query hooks while this screen composes the workspace experience.
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowRight, Building2, Check, FolderKanban, Plus, Settings } from 'lucide-react';
import React, {
  type FormEvent,
  useEffect,
  useMemo,
  useState
} from 'react';
import { useForm } from 'react-hook-form';
import { Toast } from '../../components/shared/Toast.js';
import { TixoraLoader } from '../../components/shared/TixoraLoader.js';
import {
  useChangePassword,
  useDeleteAccount,
  useLeaveOrganization,
  useUpdateProfile
} from '../account/hooks.js';
import { ActivityView } from '../activity/ActivityView.js';
import { AskTixoraPanel } from '../assistant/AskTixoraPanel.js';
import { CalendarView } from '../calendar/CalendarView.js';
import { SettingsView, type SettingsSection } from '../settings/SettingsView.js';
import { MyTasksView } from '../tasks/my-tasks/MyTasksView.js';
import './onboarding.css';
import { OrganizationMembersStep } from '../organizations/OrganizationMembersStep.js';
import { ProjectCreationForm } from '../projects/ProjectCreationForm.js';
import { WorkspaceSidebar } from './WorkspaceSidebar.js';
import type { WorkspaceView } from './workspaceView.js';
import type { AuthResponse } from '../auth/types.js';
import type {
  CommentFormValues,
  ProjectEditFormValues,
  ProjectFormValues,
  TaskEditFormValues,
  TaskFormValues
} from './workspaceSchemas.js';
import {
  projectFormSchema,
} from './workspaceSchemas.js';
import { uniqueById } from '../../lib/collections.js';
import {
  getInitials,
  toApiDateTime
} from '../../lib/formatters.js';
import {
  useAddOrganizationMember,
  useCreateInvitation,
  useCreateOrganization,
  useInvitations,
  useOrganization,
  useOrganizations,
  useRemoveOrganizationMember,
  useUpdateOrganizationMember
} from '../organizations/hooks.js';
import {
  useArchiveProject,
  useCreateProject,
  useProject,
  useProjects,
  useRemoveProjectMember,
  useUpdateProject,
  useUpsertProjectMember
} from '../projects/hooks.js';
import {
  useCreateTask,
  useTasks,
  useUpdateTask
} from '../tasks/hooks.js';
import { KanbanBoard } from '../tasks/board/KanbanBoard.js';
import { CreateTaskModal } from '../tasks/CreateTaskModal.js';
import { TaskDetailDrawer } from '../tasks/task-detail/TaskDetailDrawer.js';
import { useDragAndDrop } from '../tasks/board/useDragAndDrop.js';
import { TaskFilterPopover } from '../tasks/filters/TaskFilterPopover.js';
import { useTaskFilters } from '../tasks/filters/useTaskFilters.js';
import { useTaskKeyboardNav } from '../tasks/task-detail/useTaskKeyboardNav.js';
import {
  useComments,
  useCreateComment,
  useDeleteComment,
  useUpdateComment
} from '../comments/hooks.js';
import type {
  CommentSummary,
  ProjectMember,
  TaskSummary
} from './types.js';

type WorkspaceProps = {
  session: AuthResponse;
  entryPoint: 'login' | 'register' | 'restored';
  onLogout: (message?: string) => void;
  onSessionChange: (session: AuthResponse) => void;
};

const priorityLabels: Record<TaskSummary['priority'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent'
};

const statusLabels: Record<TaskSummary['status'], string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done'
};
const workspaceViews: WorkspaceView[] = ['board', 'my-tasks', 'calendar', 'activity', 'ask', 'settings'];

function parseWorkspacePath(pathname: string): WorkspaceView {
  const view = pathname.replace(/^\//, '') || 'board';
  return workspaceViews.includes(view as WorkspaceView) ? (view as WorkspaceView) : 'board';
}

function buildWorkspacePath(view: WorkspaceView) {
  return '/' + view;
}

function updateBrowserPath(pathname: string, replace = false) {
  if (window.location.pathname === pathname) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', pathname);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function Workspace({ session, onLogout, onSessionChange }: WorkspaceProps) {
  const [routePath, setRoutePath] = useState(() => window.location.pathname);
  const [requestedTeamSlug, setSelectedTeamSlug] = useState<string | null>(null);
  const [requestedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const activeView = parseWorkspacePath(routePath);
  const [isOrganizationFormOpen, setIsOrganizationFormOpen] = useState(false);
  const [setupStage, setSetupStage] = useState<'members' | 'project'>('members');
  const [includeArchivedProjects, setIncludeArchivedProjects] = useState(false);
  const [isProjectFormOpen, setIsProjectFormOpen] = useState(false);
  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false);
  const [isTaskDetailsOpen, setIsTaskDetailsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('profile');
  const [isOrgSwitcherOpen, setIsOrgSwitcherOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null);
  const projectForm = useForm<ProjectFormValues>({
    defaultValues: { name: '', description: '', memberIds: [] },
    resolver: zodResolver(projectFormSchema)
  });
  const {
    filters: taskFilters,
    setFilter: setTaskFilter,
    resetFilters: resetTaskFilters,
    queryFilters: taskQueryFilters,
    getFilteredTasks
  } = useTaskFilters();
  const organizationsQuery = useOrganizations();
  const teams = organizationsQuery.data?.teams ?? [];
  const selectedTeamSlug = isOrganizationFormOpen ? null :
    (teams.find((team) => team.slug === requestedTeamSlug)?.slug ?? teams[0]?.slug ?? null);
  const teamQuery = useOrganization(selectedTeamSlug);
  const teamDetail = teamQuery.data?.team ?? null;
  const projectsQuery = useProjects(
    selectedTeamSlug,
    includeArchivedProjects
  );
  const hasResolvedProjects = !selectedTeamSlug || Boolean(projectsQuery.data) || !projectsQuery.isFetching;
  const projects = hasResolvedProjects ? (projectsQuery.data?.projects ?? []) : [];
  const selectedProjectId = selectedTeamSlug ?
    (projects.find((project) => project.id === requestedProjectId)?.id ?? projects[0]?.id ?? null) : null;
  const projectQuery = useProject(selectedProjectId);
  const projectDetail = projectQuery.data?.project ?? null;
  const tasksQuery = useTasks(
    selectedProjectId,
    taskQueryFilters
  );
  const tasks = tasksQuery.data?.tasks ?? [];
  const commentsQuery = useComments(selectedTaskId);
  const comments = commentsQuery.data?.comments ?? [];
  const canManageOrganization =
    teamDetail?.role === 'owner' || teamDetail?.role === 'admin';
  const invitationsQuery = useInvitations(
    selectedTeamSlug,
    canManageOrganization
  );
  const invitations = invitationsQuery.data?.invitations ?? [];
  const needsTasks = ['board', 'my-tasks', 'calendar', 'activity'].includes(activeView);
  const requiredQueries = [organizationsQuery,
    ...(selectedTeamSlug ? [teamQuery, projectsQuery] : []),
    ...(selectedProjectId ? [projectQuery] : []),
    ...(selectedProjectId && needsTasks ? [tasksQuery] : [])];
  const failedQuery = requiredQueries.find((query) => query.isError && query.data === undefined);
  const isResolvingProjectSelection = Boolean(selectedTeamSlug) && projectsQuery.isFetching && !selectedProjectId;
  const isResolvingSelectedProject =
    Boolean(selectedProjectId) && projectQuery.data === undefined;
  const isResolvingTasks =
    needsTasks && Boolean(selectedProjectId) &&
    (tasksQuery.data === undefined || (
      tasksQuery.isFetching &&
      tasks.length === 0 &&
      (projects.find((project) => project.id === selectedProjectId)?.taskCount ?? 0) > 0
    ));
  const isLoading = !failedQuery && (
    requiredQueries.some((query) => query.data === undefined) ||
    isResolvingProjectSelection ||
    isResolvingSelectedProject ||
    isResolvingTasks
  );


  const createOrganizationMutation = useCreateOrganization();
  const addOrganizationMemberMutation = useAddOrganizationMember(
    selectedTeamSlug
  );
  const updateOrganizationMemberMutation = useUpdateOrganizationMember(
    selectedTeamSlug
  );
  const removeOrganizationMemberMutation = useRemoveOrganizationMember(
    selectedTeamSlug
  );
  const createInvitationMutation = useCreateInvitation(
    selectedTeamSlug
  );
  const createProjectMutation = useCreateProject(
    selectedTeamSlug,
    includeArchivedProjects
  );
  const updateProjectMutation = useUpdateProject(
    selectedProjectId,
    selectedTeamSlug,
    includeArchivedProjects
  );
  const archiveProjectMutation = useArchiveProject(
    selectedProjectId,
    selectedTeamSlug,
    includeArchivedProjects
  );
  const upsertProjectMemberMutation = useUpsertProjectMember(
    selectedProjectId
  );
  const removeProjectMemberMutation = useRemoveProjectMember(
    selectedProjectId
  );
  const createTaskMutation = useCreateTask(
    selectedProjectId,
    taskQueryFilters
  );
  const updateTaskMutation = useUpdateTask(
    selectedProjectId
  );
  const createCommentMutation = useCreateComment(
    selectedTaskId
  );
  const updateCommentMutation = useUpdateComment(
    selectedTaskId
  );
  const deleteCommentMutation = useDeleteComment(
    selectedTaskId
  );
  const updateProfileMutation = useUpdateProfile();
  const changePasswordMutation = useChangePassword();
  const leaveOrganizationMutation = useLeaveOrganization(
    selectedTeamSlug
  );
  const deleteAccountMutation = useDeleteAccount();

  const isCreatingOrganization = createOrganizationMutation.isPending;
  const isCreatingProject = createProjectMutation.isPending;
  const isSavingOrganizationMembers =
    addOrganizationMemberMutation.isPending ||
    createInvitationMutation.isPending ||
    updateOrganizationMemberMutation.isPending ||
    removeOrganizationMemberMutation.isPending;
  const isSavingProjectMembers =
    upsertProjectMemberMutation.isPending || removeProjectMemberMutation.isPending;
  const isSavingProject = updateProjectMutation.isPending;
  const isArchivingProject = archiveProjectMutation.isPending;
  const isCreatingTask = createTaskMutation.isPending;
  const isSavingTask = updateTaskMutation.isPending;
  const isCreatingComment = createCommentMutation.isPending;
  const isUpdatingComment = updateCommentMutation.isPending;
  const isDeletingComment = deleteCommentMutation.isPending;
  const isUpdatingProfile = updateProfileMutation.isPending;
  const isChangingPassword = changePasswordMutation.isPending;
  const isLeavingOrganization = leaveOrganizationMutation.isPending;
  const isDeletingAccount = deleteAccountMutation.isPending;

  const selectedTeam = useMemo(
    () => teams.find((team) => team.slug === selectedTeamSlug) ?? null,
    [selectedTeamSlug, teams]
  );
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks]
  );
  const selectedTaskNumber = useMemo(() => {
    const taskIndex = tasks.findIndex((task) => task.id === selectedTaskId);
    return taskIndex >= 0 ? taskIndex + 1 : null;
  }, [selectedTaskId, tasks]);
  const workspaceMembers = useMemo(
    () => uniqueById(teamDetail?.members ?? []),
    [teamDetail?.members]
  );
  const projectMembers = useMemo(
    () => uniqueById(projectDetail?.members ?? []),
    [projectDetail?.members]
  );
  const setupStep = !selectedTeamSlug ? 1 : setupStage === 'members' ? 2 : 3;
  const shouldShowSetupFlow = !isLoading && (isOrganizationFormOpen || !selectedTeamSlug ||
    (!selectedProject && canManageOrganization && activeView === 'board'));
  const hasTaskFilters = Object.values(taskQueryFilters).some(Boolean) || Boolean(taskFilters.search.trim());
  const visibleTasks = useMemo(
    () => getFilteredTasks(tasks),
    [getFilteredTasks, tasks]
  );

  const taskColumns = useMemo<
    Array<{
      id: TaskSummary['status'];
      title: string;
      tasks: TaskSummary[];
    }>
  >(
    () => [
      {
        id: 'todo',
        title: 'To do',
        tasks: visibleTasks.filter((task) => task.status === 'todo')
      },
      {
        id: 'in_progress',
        title: 'In progress',
        tasks: visibleTasks.filter((task) => task.status === 'in_progress')
      },
      {
        id: 'blocked',
        title: 'Blocked',
        tasks: visibleTasks.filter((task) => task.status === 'blocked')
      },
      {
        id: 'done',
        title: 'Done',
        tasks: visibleTasks.filter((task) => task.status === 'done')
      }
    ],
    [visibleTasks]
  );

  useEffect(() => {
    projectForm.reset({ name: '', description: '', memberIds: [] });
    setSetupStage('members');
  }, [selectedTeamSlug, projectForm]);

  function showToast(message: string, tone: 'success' | 'error' = 'success') {
    setToast({ message, tone });
  }

  function showError(fallback: string, caught: unknown) {
    const message = caught instanceof Error ? caught.message : fallback;
    setError(message);
    showToast(message, 'error');
  }

  async function handleUpdateProfile(input: { displayName?: string; email?: string }) {
    try {
      setError(null);
      const response = await updateProfileMutation.mutateAsync(input);
      onSessionChange({
        ...session,
        user: response.user
      });
      showToast('Profile updated.');
      return true;
    } catch (profileError) {
      showError('Profile update failed', profileError);
      return false;
    }
  }

  async function handleChangePassword(input: { currentPassword: string; newPassword: string }) {
    try {
      setError(null);
      await changePasswordMutation.mutateAsync(input);
      showToast('Password changed.');
      return true;
    } catch (passwordError) {
      showError('Password change failed', passwordError);
      return false;
    }
  }

  async function handleLeaveOrganization() {
    if (!selectedTeamSlug) return false;

    try {
      setError(null);
      const leavingSlug = selectedTeamSlug;
      await leaveOrganizationMutation.mutateAsync();
      setSelectedTeamSlug((currentSlug) => currentSlug === leavingSlug ? null : currentSlug);
      setSelectedProjectId(null);
      setSelectedTaskId(null);
      setSettingsSection('profile');
      navigateWorkspace('board');
      showToast('You left the organization.');
      return true;
    } catch (leaveError) {
      showError('Leave organization failed', leaveError);
      return false;
    }
  }

  async function handleDeleteAccount() {
    try {
      setError(null);
      await deleteAccountMutation.mutateAsync();
      onLogout('Account deleted.');
      return true;
    } catch (deleteError) {
      showError('Delete account failed', deleteError);
      return false;
    }
  }

  useEffect(() => {
    if (!toast) return;

    const timeoutId = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  useEffect(() => {
    function handlePopState() {
      setRoutePath(window.location.pathname);
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  function navigateWorkspace(view: WorkspaceView, replace = false) {
    const nextPath = buildWorkspacePath(view);
    updateBrowserPath(nextPath, replace);
    setRoutePath(nextPath);
  }


  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedTaskId(null);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || tasksQuery.isLoading || !selectedTaskId) return;
    if (!tasks.some((task) => task.id === selectedTaskId)) {
      setIsTaskDetailsOpen(false);
      setSelectedTaskId(null);
    }
  }, [selectedProjectId, selectedTaskId, tasks, tasksQuery.isLoading]);



  useEffect(() => {
    if (!selectedTaskId) {
      setIsTaskDetailsOpen(false);
    }
  }, [selectedTaskId]);



  async function handleCreateTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const name = workspaceName.trim();

    if (!name) {
      setError('Organization name is required.');
      return;
    }

    try {
      setError(null);
      const response = await createOrganizationMutation.mutateAsync({ name });
      setIsOrganizationFormOpen(false);
      setSetupStage('members');
      setSelectedTeamSlug(response.team.slug);
      navigateWorkspace('board');
      setIsProjectFormOpen(false);
      showToast('Organization created.');
      setWorkspaceName('');
    } catch (createError) {
      showError('Organization creation failed', createError);
    }
  }

  async function handleCreateProject(values: ProjectFormValues) {
    if (!selectedTeamSlug) {
      setError('Select or create an organization before creating a project.');
      return;
    }

    try {
      setError(null);
      const response = await createProjectMutation.mutateAsync({
        name: values.name,
        description: values.description || undefined,
        memberIds: values.memberIds
      });
      setSelectedProjectId(response.project.id);
      setSelectedTaskId(null);
      navigateWorkspace('board');
      projectForm.reset();
      setIsProjectFormOpen(false);
      showToast('Project created.');
    } catch (createError) {
      showError('Project creation failed', createError);
    }
  }

  async function handleAddOrganizationMembers(
    emails: string[],
    role: 'admin' | 'member'
  ) {
    if (!selectedTeamSlug) return;

    if (emails.length === 0) {
      setError('Select registered members or enter an email to invite.');
      return;
    }

    try {
      setError(null);
      await Promise.all(
        emails.map((email) =>
          addOrganizationMemberMutation.mutateAsync({ email, role })
        )
      );
      showToast(emails.length === 1 ? 'Organization member added.' : emails.length + ' organization members added.');
    } catch (memberError) {
      showError('Organization member update failed', memberError);
    }
  }

  async function handleInviteOrganizationMember(
    email: string,
    role: 'admin' | 'member'
  ) {
    if (!selectedTeamSlug) return;

    try {
      setError(null);
      await createInvitationMutation.mutateAsync({ email, role });
      showToast('Invitation sent.');
    } catch (memberError) {
      showError('Organization user update failed', memberError);
    }
  }

  async function handleTeamRoleChange(
    userId: string,
    role: 'admin' | 'member'
  ) {
    if (!selectedTeamSlug) return;

    try {
      setError(null);
      await updateOrganizationMemberMutation.mutateAsync({ userId, role });
      showToast('Organization role updated.');
    } catch (memberError) {
      showError('Organization member role update failed', memberError);
    }
  }

  async function handleRemoveTeamMember(userId: string) {
    if (!selectedTeamSlug) return;

    try {
      setError(null);
      await removeOrganizationMemberMutation.mutateAsync(userId);
      showToast('Organization member removed.');
    } catch (memberError) {
      showError('Organization member remove failed', memberError);
    }
  }

  async function handleAddProjectMembers(
    userIds: string[],
    role: ProjectMember['role']
  ) {
    if (!selectedProjectId || userIds.length === 0) {
      setError('Select at least one organization member to add to the project.');
      return;
    }

    try {
      setError(null);
      await Promise.all(
        userIds.map((userId) =>
          upsertProjectMemberMutation.mutateAsync({ userId, role })
        )
      );
      showToast(userIds.length === 1 ? 'Project member added.' : userIds.length + ' project members added.');
    } catch (memberError) {
      showError('Project member update failed', memberError);
    }
  }

  async function handleProjectRoleChange(
    userId: string,
    role: ProjectMember['role']
  ) {
    if (!selectedProjectId) return;

    try {
      setError(null);
      await upsertProjectMemberMutation.mutateAsync({ userId, role });
      showToast('Project role updated.');
    } catch (memberError) {
      showError('Project member role update failed', memberError);
    }
  }

  async function handleRemoveProjectMember(userId: string) {
    if (!selectedProjectId) return;

    try {
      setError(null);
      await removeProjectMemberMutation.mutateAsync(userId);
      showToast('Project member removed.');
    } catch (memberError) {
      showError('Project member remove failed', memberError);
    }
  }

  async function handleUpdateProject(values: ProjectEditFormValues) {
    if (!selectedProjectId) return;

    try {
      setError(null);
      await updateProjectMutation.mutateAsync({
        name: values.name,
        description: values.description?.trim() || null
      });
      showToast('Project saved.');
    } catch (updateError) {
      showError('Project update failed', updateError);
    }
  }

  async function handleArchiveProject() {
    if (!selectedProjectId) return;

    try {
      setError(null);
      const response = await archiveProjectMutation.mutateAsync();
      setSelectedProjectId((currentId) => {
        if (currentId !== response.project.id) return currentId;
        const nextProject = projects.find(
          (project) => project.id !== response.project.id
        );
        return nextProject?.id ?? null;
      });
      showToast('Project archived.');
    } catch (archiveError) {
      showError('Project archive failed', archiveError);
    }
  }

  async function handleCreateTask(values: TaskFormValues) {
    if (!selectedProjectId) {
      setError('Create or select a project before creating a task.');
      return;
    }

    try {
      setError(null);
      const response = await createTaskMutation.mutateAsync({
        title: values.title,
        description: values.description || undefined,
        dueAt: toApiDateTime(values.dueAt),
        priority: values.priority,
        assigneeIds: values.assigneeIds ?? []
      });
      resetTaskFilters();
      setSelectedTaskId(response.task.id);
      navigateWorkspace('board');
      setIsTaskFormOpen(false);
      showToast('Task created.');
      return true;
    } catch (createError) {
      showError('Task creation failed', createError);
      return false;
    }
  }
  async function handleUpdateTask(values: TaskEditFormValues) {
    if (!selectedTaskId) return;

    try {
      setError(null);
      const response = await updateTaskMutation.mutateAsync({
        taskId: selectedTaskId,
        values: {
          title: values.title,
          description: values.description || null,
          dueAt: toApiDateTime(values.dueAt),
          priority: values.priority,
          assigneeIds: values.assigneeIds
        }
      });
      setSelectedTaskId(response.task.id);
      showToast('Task saved.');
      setIsTaskDetailsOpen(false);
    } catch (updateError) {
      showError('Task update failed', updateError);
    }
  }

  async function handleTaskStatusChange(
    taskId: string,
    status: TaskSummary['status']
  ) {
    try {
      setError(null);
      const response = await updateTaskMutation.mutateAsync({
        taskId,
        values: { status }
      });
      setSelectedTaskId(response.task.id);
      showToast('Task status updated.');
    } catch (updateError) {
      showError('Task update failed', updateError);
    }
  }

  const {
    draggingTaskId,
    dragOverStatus,
    handleTaskDragStart,
    handleTaskDragEnd,
    handleColumnDragOver,
    handleColumnDragLeave,
    handleColumnDrop
  } = useDragAndDrop(tasks, handleTaskStatusChange);


  async function handleCreateComment(values: CommentFormValues) {
    if (!selectedTaskId) {
      setError('Select a task before adding a comment.');
      return;
    }

    try {
      setError(null);
      await createCommentMutation.mutateAsync({ body: values.body });
      showToast('Comment added.');
    } catch (createError) {
      showError('Comment creation failed', createError);
    }
  }

  async function handleUpdateComment(
    commentId: string,
    values: CommentFormValues
  ) {
    try {
      setError(null);
      await updateCommentMutation.mutateAsync({
        commentId,
        body: values.body
      });
      showToast('Comment updated.');
    } catch (updateError) {
      showError('Comment update failed', updateError);
    }
  }

  async function handleDeleteComment(commentId: string) {
    try {
      setError(null);
      await deleteCommentMutation.mutateAsync(commentId);
      showToast('Comment deleted.');
    } catch (deleteError) {
      showError('Comment delete failed', deleteError);
    }
  }

  function closeTaskDetails() {
    setIsTaskDetailsOpen(false);
    setSelectedTaskId(null);
  }

  function openTaskDetails(taskId: string) {
    setSelectedTaskId(taskId);
    setIsTaskDetailsOpen(true);
  }

  function navigateTaskDetails(taskId: string) {
    setSelectedTaskId(taskId);
  }

  useTaskKeyboardNav(
    isTaskDetailsOpen,
    tasks,
    selectedTaskId,
    navigateTaskDetails,
    closeTaskDetails
  );


  function openOrganizationSettings() {
    setSettingsSection('organization');
    navigateWorkspace('settings');
  }

  function openProjectMembersSettings() {
    setSettingsSection('project');
    navigateWorkspace('settings');
  }

  function openProjectGeneralSettings() {
    setSettingsSection('project');
    navigateWorkspace('settings');
  }


  return (
    <main
      className={[
        'workspace-shell board-app',
        shouldShowSetupFlow ? 'workspace-onboarding' : '',
        isSidebarCollapsed ? 'sidebar-collapsed' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <WorkspaceSidebar
        session={session}
        teams={teams}
        teamDetail={teamDetail}
        selectedTeamSlug={selectedTeamSlug}
        projects={projects}
        selectedProjectId={selectedProjectId}
        selectedProject={selectedProject}
        workspaceMemberCount={workspaceMembers.length}
        projectMemberCount={projectMembers.length}
        isResolvingProjects={Boolean(selectedTeamSlug) && projectsQuery.isFetching && !projectsQuery.data}
        includeArchivedProjects={includeArchivedProjects}
        isCollapsed={isSidebarCollapsed}
        isOrgSwitcherOpen={isOrgSwitcherOpen}
        activeView={activeView}
        activeSettingsSection={settingsSection}
        onToggleCollapsed={() => setIsSidebarCollapsed((current) => !current)}
        onToggleOrgSwitcher={() => setIsOrgSwitcherOpen((current) => !current)}
        onSelectOrganization={(slug) => {
          setIsOrganizationFormOpen(false);
          setIsProjectFormOpen(false);
          setIsTaskFormOpen(false);
          setIsTaskDetailsOpen(false);
          resetTaskFilters();
          setError(null);
          setSelectedTeamSlug(slug);
          setSelectedProjectId(null);
          setSelectedTaskId(null);
          navigateWorkspace('board');
          setIsOrgSwitcherOpen(false);
        }}
        onCreateOrganization={() => {
          setIsOrganizationFormOpen(true);
          setIsProjectFormOpen(false);
          setIsTaskFormOpen(false);
          setIsTaskDetailsOpen(false);
          setError(null);
          setWorkspaceName('');
          setSelectedTeamSlug(null);
          setSelectedProjectId(null);
          setSelectedTaskId(null);
          navigateWorkspace('board');
          setIsOrgSwitcherOpen(false);
        }}
        onToggleProjectForm={() => {
          if (!canManageOrganization) return;
          projectForm.reset({ name: '', description: '', memberIds: [] });
          setIsProjectFormOpen((current) => !current);
          navigateWorkspace('board');
        }}
        onIncludeArchivedChange={setIncludeArchivedProjects}
        onSelectProject={(projectId) => {
          setIsTaskFormOpen(false);
          setIsTaskDetailsOpen(false);
          setIsProjectFormOpen(false);
          resetTaskFilters();
          setError(null);
          setSelectedProjectId(projectId);
          setSelectedTaskId(null);
          navigateWorkspace('board');
        }}
        onSelectView={(view) => {
          if (view === 'settings') setSettingsSection('profile');
          setSelectedTaskId(null);
          navigateWorkspace(view);
        }}
        onOpenOrganizationMembers={openOrganizationSettings}
        onOpenProjectMembers={openProjectMembersSettings}
        onLogout={onLogout}
      />

      <section className="board-workspace">
        {error ? <p className="error-message">{error}</p> : null}

        {failedQuery ? (
          <section className="empty-state" role="alert">
            <h2>Could not load your workspace</h2>
            <p>{failedQuery.error instanceof Error ? failedQuery.error.message : 'Please try again.'}</p>
            <button type="button" className="primary-button" onClick={() => void failedQuery.refetch()}>Retry</button>
          </section>
        ) : isLoading ? (
          <TixoraLoader variant="panel" />
        ) : shouldShowSetupFlow ? (
          <section className="setup-flow onboarding">
            <div className="setup-intro">
              <div className="onboarding-eyebrow"><span className="onboarding-dot" />LET’S GET YOU SET UP</div>
              <h1>A home for your team’s best work.</h1>
              <p>A few details now. A more organized workday ahead.</p>
            </div>
            <ol className="setup-steps" aria-label="Setup progress">
              {[
                [1, "Organization", "Create your workspace"],
                [2, "Members", "Bring your team together"],
                [3, "Project", "Start something great"]
              ].map(([step, title, body]) => (
                <li key={step} aria-current={setupStep === Number(step) ? 'step' : undefined}
                  className={setupStep > Number(step) ? 'setup-step done' : setupStep === Number(step) ? 'setup-step active' : 'setup-step'}>
                  <span>{setupStep > Number(step) ? <Check size={15} aria-hidden="true" /> : step}</span>
                  <div><strong>{title}</strong><p>{body}</p></div>
                </li>
              ))}
            </ol>
            <div className="onboarding-card-label"><span>YOUR WORKSPACE</span><span>Step {setupStep} of 3</span></div>
            <div className="setup-card">
              {setupStep === 1 ? (
                <>
                  <div className="setup-card-heading">
                    <span className="onboarding-feature-icon"><Building2 size={23} aria-hidden="true" /></span>
                    <h2>Create organization</h2>
                    <p>Give your team a shared space for projects, people, and progress.</p>
                  </div>
                  <form className="setup-form vertical" onSubmit={handleCreateTeam}>
                    <label>
                      Organization name
                      <input
                        value={workspaceName}
                        onChange={(event) => setWorkspaceName(event.target.value)}
                        placeholder="Example: Acme Operations"
                      />
                    </label>
                    <button type="submit" className="primary-button" disabled={isCreatingOrganization}>
                      {isCreatingOrganization ? 'Creating...' : <>Create organization <ArrowRight size={16} aria-hidden="true" /></>}
                    </button>
                    {isOrganizationFormOpen && teams.length > 0 ? <button type="button" className="ghost-button" disabled={isCreatingOrganization} onClick={() => { setIsOrganizationFormOpen(false); setError(null); }}>Cancel</button> : null}
                  </form>
                </>
              ) : null}

              {setupStep === 2 ? (
                <OrganizationMembersStep
                  key={selectedTeamSlug}
                  members={workspaceMembers}
                  isSaving={isSavingOrganizationMembers}
                  onAddMembers={async (emails, role) => {
                    setError(null);
                    const results = await Promise.allSettled(emails.filter((email) => !workspaceMembers.some((member) => member.email === email)).map((email) => addOrganizationMemberMutation.mutateAsync({ email, role })));
                    await teamQuery.refetch();
                    const failure = results.find((result) => result.status === 'rejected');
                    if (failure?.status === 'rejected') { showError('Could not add members', failure.reason); return false; }
                    showToast('Organization members added.');
                    return true;
                  }}
                  onContinue={() => setSetupStage('project')}
                />
              ) : null}
              {setupStep === 3 ? (
                <>
                  <div className="setup-card-heading"><span className="onboarding-feature-icon"><FolderKanban size={23} aria-hidden="true" /></span><h2>Create your first project</h2><p>Set a direction and choose the people who will make it happen.</p></div>
                  <ProjectCreationForm form={projectForm} members={workspaceMembers} currentUserId={session.user.id}
                    isSaving={isCreatingProject} onSubmit={handleCreateProject} onManageMembers={() => setSetupStage('members')} />
                </>
              ) : null}

            </div>
            <p className="onboarding-bottom-note">Make it yours. You can update your workspace details later.</p>
          </section>
        ) : (
          <>
            <header className="board-header">
              <div className="project-title">
                <div>
                  <h1>{selectedProject?.name ?? 'Select a project'}</h1>
                  <p>{selectedProject?.description ?? selectedTeam?.name}</p>
                </div>
              </div>

              <div className="board-actions">
                <div className="assignee-stack header-stack">
                  {projectMembers.slice(0, 4).map((member) => (
                    <span key={member.id} className="avatar">
                      {getInitials(member.displayName)}
                    </span>
                  ))}
                  {projectMembers.length > 4 ? (
                    <span className="avatar overflow-avatar">
                      +{projectMembers.length - 4}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="icon-button !h-[38px] !min-h-[38px] !w-[38px] !p-0 !text-base"
                  disabled={!selectedProject}
                  onClick={openProjectGeneralSettings}
                  aria-label="Project settings"
                  title="Project settings"
                >
                  <Settings aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!selectedProject}
                  onClick={() => setIsTaskFormOpen(true)}
                >
                  <Plus aria-hidden="true" />
                  Create task
                </button>
              </div>
            </header>

            <div className="board-toolbar compact-toolbar">
              <input
                value={taskFilters.search}
                onChange={(event) => setTaskFilter('search', event.target.value)}
                disabled={!selectedProject}
                placeholder="Search tasks..."
              />
              <TaskFilterPopover
                disabled={!selectedProject}
                filters={taskFilters}
                projectMembers={projectMembers}
                priorityLabels={priorityLabels}
                statusLabels={statusLabels}
                onFilterChange={setTaskFilter}
              />
            </div>

            {isProjectFormOpen && canManageOrganization ? (
              <section className="setup-card mb-6" aria-label="Create project">
                <h2>Create project</h2>
                <ProjectCreationForm form={projectForm} members={workspaceMembers} currentUserId={session.user.id}
                  isSaving={isCreatingProject} onSubmit={handleCreateProject} onManageMembers={openOrganizationSettings}
                  onCancel={() => setIsProjectFormOpen(false)} />
              </section>
            ) : null}

            {activeView === 'board' ? (
              <>
                {selectedProject && visibleTasks.length === 0 ? (
                  <section className="board-empty-panel board-empty-actions">
                    <div>
                      <p className="section-kicker">{hasTaskFilters ? 'Filtered results' : 'Empty board'}</p>
                      <h2>{hasTaskFilters ? 'No matching tasks' : 'Start your project'}</h2>
                      <p>{hasTaskFilters ? 'Clear your filters to see the other tasks in this project.' : 'Your project members are ready. Create a task and choose who should work on it.'}</p>
                    </div>
                    <div className="empty-cta-row">
                      <button
                        type="button"
                        className="primary-button equal-cta"
                        onClick={() => hasTaskFilters ? resetTaskFilters() : setIsTaskFormOpen(true)}
                      >
                        {hasTaskFilters ? 'Clear filters' : 'Create your first task'}
                      </button>
                      <button
                        type="button"
                        className="ghost-button equal-cta"
                        onClick={openProjectMembersSettings}
                      >
                        Review project members
                      </button>
                    </div>
                  </section>
                ) : null}

                {!selectedProject ? (
                  <section className="locked-panel">
                    <p className="section-kicker">Project required</p>
                    <h3>Create or select a project</h3>
                    <p>
                      Use the Projects area in the sidebar to choose a project, or
                      create a new one to unlock the board.
                    </p>
                  </section>
                ) : visibleTasks.length > 0 ? (
                  <KanbanBoard
                    columns={taskColumns}
                    selectedTaskId={selectedTaskId}
                    draggingTaskId={draggingTaskId}
                    dragOverStatus={dragOverStatus}
                    priorityLabels={priorityLabels}
                    onOpenTask={openTaskDetails}
                    onTaskDragStart={handleTaskDragStart}
                    onTaskDragEnd={handleTaskDragEnd}
                    onColumnDragOver={handleColumnDragOver}
                    onColumnDragLeave={handleColumnDragLeave}
                    onColumnDrop={(event, status) => void handleColumnDrop(event, status)}
                  />
                ) : null}
              </>
            ) : null}

            {activeView === 'my-tasks' ? (
              <MyTasksView
                tasks={tasks}
                currentUserId={session.user.id}
                priorityLabels={priorityLabels}
                statusLabels={statusLabels}
                onOpenTask={openTaskDetails}
              />
            ) : null}

            {activeView === 'calendar' ? (
              <CalendarView
                tasks={tasks}
                statusLabels={statusLabels}
                onOpenTask={openTaskDetails}
              />
            ) : null}

            {activeView === 'activity' ? (
              <ActivityView
                tasks={tasks}
                statusLabels={statusLabels}
                onOpenTask={openTaskDetails}
              />
            ) : null}

            {activeView === 'ask' ? (
              <AskTixoraPanel
                key={JSON.stringify([session.user.id, selectedTeamSlug, selectedProjectId])}
                userId={session.user.id}
                orgSlug={selectedTeamSlug}
                projectId={selectedProjectId}
                onOpenTask={openTaskDetails}
              />
            ) : null}

            {activeView === 'settings' ? (
              <SettingsView
                session={session}
                activeSection={settingsSection}
                team={teamDetail}
                project={selectedProject}
                projectDetail={projectDetail}
                workspaceMembers={workspaceMembers}
                projectMembers={projectMembers}
                invitations={invitations}
                isSavingOrganizationMembers={isSavingOrganizationMembers}
                isSavingProject={isSavingProject}
                isArchivingProject={isArchivingProject}
                isSavingProjectMembers={isSavingProjectMembers}
                isUpdatingProfile={isUpdatingProfile}
                isChangingPassword={isChangingPassword}
                isLeavingOrganization={isLeavingOrganization}
                isDeletingAccount={isDeletingAccount}
                onSectionChange={setSettingsSection}
                onAddMembers={handleAddOrganizationMembers}
                onInviteMember={handleInviteOrganizationMember}
                onOrganizationRoleChange={handleTeamRoleChange}
                onRemoveOrganizationMember={handleRemoveTeamMember}
                onUpdateProfile={handleUpdateProfile}
                onChangePassword={handleChangePassword}
                onLeaveOrganization={handleLeaveOrganization}
                onDeleteAccount={handleDeleteAccount}
                onUpdateProject={handleUpdateProject}
                onArchiveProject={handleArchiveProject}
                onAddProjectMembers={handleAddProjectMembers}
                onProjectRoleChange={handleProjectRoleChange}
                onRemoveProjectMember={handleRemoveProjectMember}
              />
            ) : null}
          </>
        )}
      </section>

      <CreateTaskModal
        key={selectedProjectId ?? 'no-project'}
        isOpen={isTaskFormOpen}
        projectName={selectedProject?.name}
        projectMembers={projectMembers}
        priorityLabels={priorityLabels}
        onClose={() => setIsTaskFormOpen(false)}
        isSubmitting={isCreatingTask}
        onSubmit={handleCreateTask}
        onManageProjectMembers={() => {
          setIsTaskFormOpen(false);
          openProjectMembersSettings();
        }}
        onAddOrganizationMember={() => {
          setIsTaskFormOpen(false);
          openOrganizationSettings();
        }}
      />

      <TaskDetailDrawer
        isOpen={isTaskDetailsOpen}
        task={selectedTask}
        taskNumber={selectedTaskNumber}
        project={selectedProject}
        projectDetail={projectDetail}
        workspaceMemberCount={workspaceMembers.length}
        projectMembers={projectMembers}
        comments={comments}
        priorityLabels={priorityLabels}
        statusLabels={statusLabels}
        isSavingTask={isSavingTask}
        isCreatingComment={isCreatingComment}
        isUpdatingComment={isUpdatingComment}
        isDeletingComment={isDeletingComment}
        onClose={closeTaskDetails}
        onUpdateTask={handleUpdateTask}
        onCreateComment={handleCreateComment}
        onUpdateComment={handleUpdateComment}
        onDeleteComment={handleDeleteComment}
        onManageProjectMembers={() => {
          setIsTaskDetailsOpen(false);
          openProjectMembersSettings();
        }}
        onAddOrganizationMember={() => {
          setIsTaskDetailsOpen(false);
          openOrganizationSettings();
        }}
      />

      <Toast message={toast?.message ?? null} tone={toast?.tone} />
    </main>
  );
}
