import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, ShieldCheck, Trash, UsersThree } from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { createRole, deleteRole, reorderRoles, setEveryonePermissions, updateRole } from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { PERM, PERM_INFO, sortedRoles, topPosition } from '../../lib/perms';
import { useData } from '../../store/data';
import { ui } from '../../store/ui';
import { Button, Switch, TextField } from '../ui';

const ROLE_COLORS = ['#e5534b', '#f08a5d', '#f2b84b', '#5cc443', '#3fbfa5', '#39b5e0', '#2c6fcb', '#8b7cf6', '#c178e6', '#ec6fa6', '#9aa092', null];

function run(p: Promise<unknown>) {
  p.catch((err) => ui.toast(errorMessage(err), 'error'));
}

export function RolesTab({ groupId }: { groupId: string }) {
  const roles = useData(useShallow((s) => sortedRoles(s, groupId)));
  const everyone = useData((s) => s.groups[groupId]?.everyonePermissions ?? 0);
  const myTop = useData((s) => topPosition(s, groupId, s.me!.id));
  const isAdmin = useData((s) => {
    const r = s.groups[groupId]?.members[s.me!.id]?.role;
    return r === 'owner' || r === 'admin';
  });
  const counts = useData(
    useShallow((s) => {
      const out: Record<string, number> = {};
      for (const m of Object.values(s.groups[groupId]?.members ?? {})) for (const r of m.roles) out[r] = (out[r] ?? 0) + 1;
      return out;
    }),
  );
  const [selected, setSelected] = useState<string>(roles[0]?.id ?? 'everyone');
  const role = roles.find((r) => r.id === selected) ?? null;
  const editable = selected === 'everyone' ? true : Boolean(role && role.position < myTop);

  const [name, setName] = useState(role?.name ?? '');
  useEffect(() => setName(role?.name ?? ''), [role?.id, role?.name]);

  const perms = selected === 'everyone' ? everyone : role?.permissions ?? 0;
  const togglePerm = (bit: number, on: boolean) => {
    const next = on ? perms | bit : perms & ~bit;
    if (selected === 'everyone') run(setEveryonePermissions(groupId, next));
    else if (role) run(updateRole(groupId, role.id, { permissions: next }));
  };

  const move = (dir: -1 | 1) => {
    if (!role) return;
    const ids = roles.map((r) => r.id);
    const i = ids.indexOf(role.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    run(reorderRoles(groupId, ids));
  };

  const visiblePerms = useMemo(
    () => (selected === 'everyone' ? PERM_INFO.filter((p) => p.bit !== PERM.ADMINISTRATOR) : PERM_INFO),
    [selected],
  );

  return (
    <div className="roles">
      <div className="roles-list">
        <Button
          size="sm"
          block
          icon={<Plus size={14} weight="bold" />}
          onClick={async () => {
            try {
              const r = await createRole(groupId, { name: 'new role', color: '#39b5e0' });
              setSelected(r.id);
            } catch (err) {
              ui.toast(errorMessage(err), 'error');
            }
          }}
        >
          Create role
        </Button>
        <div className="roles-items scroll">
          {roles.map((r) => (
            <button key={r.id} className={`roles-item${selected === r.id ? ' is-active' : ''}`} onClick={() => setSelected(r.id)}>
              <span className="role-dot" style={{ background: r.color ?? 'var(--text-4)' }} />
              <span className="truncate">{r.name}</span>
              <span className="roles-count">{counts[r.id] ?? 0}</span>
            </button>
          ))}
          <button className={`roles-item${selected === 'everyone' ? ' is-active' : ''}`} onClick={() => setSelected('everyone')}>
            <UsersThree size={14} weight="bold" />
            <span className="truncate">@everyone</span>
          </button>
        </div>
        <p className="roles-hint">Higher roles win. Owners and admins outrank every role.</p>
      </div>

      <div className="roles-editor">
        {selected === 'everyone' ? (
          <div className="roles-head">
            <h3>@everyone</h3>
            <p className="muted">What everyone in the group can do by default.</p>
          </div>
        ) : role ? (
          <>
            <div className="roles-head">
              <TextField
                label="Role name"
                value={name}
                maxLength={32}
                disabled={!editable}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name !== role.name && run(updateRole(groupId, role.id, { name: name.trim() }))}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              <div className="ui-field">
                <span className="ui-field-label">Color</span>
                <div className="color-swatches">
                  {ROLE_COLORS.map((c) => (
                    <button
                      key={c ?? 'none'}
                      disabled={!editable}
                      className={`swatch${(role.color ?? null) === c ? ' is-active' : ''}${c ? '' : ' swatch-none'}`}
                      style={{ background: c ?? undefined }}
                      aria-label={c ?? 'No color'}
                      onClick={() => run(updateRole(groupId, role.id, { color: c }))}
                    />
                  ))}
                </div>
              </div>
              <div className="ui-row roles-tools">
                <Button size="sm" variant="secondary" disabled={!editable} onClick={() => move(-1)} icon={<ArrowUp size={14} weight="bold" />}>
                  Move up
                </Button>
                <Button size="sm" variant="secondary" disabled={!editable} onClick={() => move(1)} icon={<ArrowDown size={14} weight="bold" />}>
                  Move down
                </Button>
                <span style={{ flex: 1 }} />
                <Button
                  size="sm"
                  variant="danger-ghost"
                  disabled={!editable}
                  icon={<Trash size={14} />}
                  onClick={() =>
                    ui.openModal('confirm', {
                      title: `Delete the ${role.name} role?`,
                      body: 'Everyone who has it loses it. This cannot be undone.',
                      confirmLabel: 'Delete role',
                      danger: true,
                      onConfirm: async () => {
                        await deleteRole(groupId, role.id);
                        setSelected('everyone');
                      },
                    })
                  }
                >
                  Delete
                </Button>
              </div>
            </div>
            <div className="setting-row">
              <span>
                <strong>Show members separately</strong>
                <small>People with this role get their own section in the member list.</small>
              </span>
              <Switch checked={role.hoist} disabled={!editable} onChange={(v) => run(updateRole(groupId, role.id, { hoist: v }))} label="Show separately" />
            </div>
            <div className="setting-row">
              <span>
                <strong>Let anyone @mention this role</strong>
                <small>Pings everyone with the role. People with "Mention @everyone" can always do it.</small>
              </span>
              <Switch checked={role.mentionable} disabled={!editable} onChange={(v) => run(updateRole(groupId, role.id, { mentionable: v }))} label="Mentionable" />
            </div>
          </>
        ) : (
          <p className="muted">Pick a role on the left.</p>
        )}

        {(selected === 'everyone' || role) && (
          <div className="roles-perms">
            <h4>
              <ShieldCheck size={16} weight="bold" /> Permissions
            </h4>
            {!editable && <p className="form-error">This role is ranked at or above your highest role, so you can't change it.</p>}
            {visiblePerms.map((p) => (
              <div key={p.bit} className="setting-row">
                <span>
                  <strong>{p.name}</strong>
                  <small>{p.hint}</small>
                </span>
                <Switch
                  checked={(perms & p.bit) === p.bit}
                  disabled={!editable || (p.bit === PERM.ADMINISTRATOR && !isAdmin)}
                  onChange={(v) => togglePerm(p.bit, v)}
                  label={p.name}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
