import { useCallback, useEffect, useState } from 'react';
import type { OrgMembership, OrgRole } from '@stewra/shared-types';
import { api } from '../../services/api';

/**
 * The org context every commerce page needs: which organizations this user belongs to, which one
 * the page is looking at, and what their role there permits.
 *
 * The initial selection follows the ACTIVE org — the one texting Stewra acts on — so the app and the
 * conversational surface agree on what "my business" means. It falls back to the first membership
 * for viewing only; nothing here ever writes the active org.
 */
export function useCommerceOrg(): {
  memberships: ReadonlyArray<OrgMembership>;
  orgId: string | null;
  setOrgId: (orgId: string) => void;
  role: OrgRole | null;
  loadError: string | null;
} {
  const [memberships, setMemberships] = useState<ReadonlyArray<OrgMembership>>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listOrgs();
      setMemberships(res.memberships);
      setOrgId((current) => current ?? res.activeOrgId ?? res.memberships[0]?.org.id ?? null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load your organizations');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const role = memberships.find((m) => m.org.id === orgId)?.role ?? null;
  return { memberships, orgId, setOrgId, role, loadError };
}
