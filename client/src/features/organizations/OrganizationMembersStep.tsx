import { ArrowRight, Search, UserPlus, UsersRound } from 'lucide-react';
import { getInitials } from '../../lib/formatters.js';
import { useEffect, useState } from 'react';
import { useUserSearch } from './hooks.js';
import type { TeamMember } from './types.js';
import { TixoraLoader } from '../../components/shared/TixoraLoader.js';

type Props = {
  members: TeamMember[];
  isSaving: boolean;
  onAddMembers: (emails: string[], role: 'member' | 'admin') => Promise<boolean>;
  onContinue: () => void;
};

export function OrganizationMembersStep({ members, isSaving, onAddMembers, onContinue }: Props) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const directory = useUserSearch(query);
  useEffect(() => {
    const timeout = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timeout);
  }, [search]);
  const available = (directory.data?.users ?? []).filter((user) => !members.some((member) => member.id === user.id));
  return (
    <div className="onboarding-members">
      <div className="setup-card-heading"><span className="onboarding-feature-icon"><UsersRound size={23} aria-hidden="true" /></span><h2>Add organization members</h2><p>Great work starts with the right people. Find your teammates and bring them into your workspace.</p></div>
      <form className="setup-form vertical onboarding-search-form" onSubmit={async (event) => {
        event.preventDefault();
        if (!selected.length || isSaving) return;
        setError(null);
        if (await onAddMembers(selected, 'member')) { setSelected([]); setSearch(''); setQuery(''); }
        else setError('Some members could not be added. Check the message above and try again.');
      }}>
        <label>Find registered teammates<span className="onboarding-search"><Search size={17} aria-hidden="true" /><input value={search} disabled={isSaving} onChange={(event) => { setSearch(event.target.value); setSelected([]); }} placeholder="Search by name or email" /></span></label>
        <p className="onboarding-field-note">Search for people who already have a Tixora account.</p>
        {search.trim() && (directory.isFetching || search.trim() !== query) ? <TixoraLoader variant="inline" label="Searching teammates..." /> : null}
        {directory.isError ? <p role="alert" className="field-error">Could not search members. <button type="button" onClick={() => void directory.refetch()}>Retry</button></p> : null}
        {query && query === search.trim() && !directory.isFetching && !directory.isError ? (
          <div className="onboarding-results">
            {available.map((user) => <label key={user.id} className="onboarding-person selectable">
              <input type="checkbox" disabled={isSaving} checked={selected.includes(user.email)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, user.email] : current.filter((email) => email !== user.email))} />
              <span className="onboarding-avatar">{getInitials(user.displayName)}</span><span className="onboarding-person-text"><strong>{user.displayName}</strong><small>{user.email}</small></span>
            </label>)}
            {!available.length ? <p className="meta-text">No new registered teammates found. Teammates need a Tixora account before you can add them here.</p> : null}
          </div>
        ) : null}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="onboarding-search-actions"><span>{selected.length ? `${selected.length} selected` : 'Select teammates from the search results'}</span><button type="submit" className="secondary-button" disabled={isSaving || selected.length === 0}><UserPlus size={15} aria-hidden="true" />{isSaving ? 'Adding members...' : `Add selected members${selected.length ? ' (' + selected.length + ')' : ''}`}</button></div>
      </form>
      <section className="onboarding-roster">
        <div className="onboarding-roster-heading"><h3>In your workspace <span>{members.length}</span></h3><span>Organization members</span></div>
        <div className="onboarding-people">{members.map((member) => <div className="onboarding-person" key={member.id}>
          <span className="onboarding-avatar">{getInitials(member.displayName)}</span>
          <div className="onboarding-person-text"><strong>{member.displayName}</strong><small>{member.email}</small></div>
          <span className="onboarding-role">{member.role}</span>
        </div>)}</div>
      </section>
      <div className="onboarding-footer">
        <p>{selected.length > 0 ? 'Add or deselect your teammates to continue.' : 'Flying solo? You’re ready for the next step.'}</p>
        <button type="button" className="primary-button" disabled={isSaving || members.length === 0 || selected.length > 0} onClick={onContinue}>Continue to project <ArrowRight size={16} aria-hidden="true" /></button>
      </div>
    </div>
  );
}
