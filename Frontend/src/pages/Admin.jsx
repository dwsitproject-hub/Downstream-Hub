import { useState, useEffect, useMemo } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiRequest, apiUpload } from '../api';
import { applicationInitials } from '../utils/applicationInitials';
import { resolveIconSrc } from '../utils/resolveIconSrc';
import MultiSelectDropdown from '../components/admin/MultiSelectDropdown';
import ApplicationIconField from '../components/admin/ApplicationIconField';
import SsoBadge from '../components/SsoBadge';
import AdminModal from '../components/admin/AdminModal';
import AdminFormModal from '../components/admin/AdminFormModal';
import HubLogo from '../components/HubLogo';

const SECTIONS = [
  { id: 'domains', label: 'Domains', path: 'domains' },
  { id: 'business-units', label: 'Departments', path: 'business-units' },
  { id: 'users', label: 'Users', path: 'users' },
  { id: 'applications', label: 'Applications', path: 'applications' },
  { id: 'analytics', label: 'Analytic', path: 'analytics' },
  { id: 'password-policy', label: 'Password policy', path: 'password-policy' },
];

/** IANA timezones for login MFA calendar-day bypass (Admin dropdown). */
const LOGIN_MFA_BYPASS_TIMEZONES = [
  { value: 'UTC', label: 'UTC — Coordinated Universal Time' },
  { value: 'Asia/Jakarta', label: 'Asia/Jakarta — WIB (UTC+7)' },
  { value: 'Asia/Makassar', label: 'Asia/Makassar — WITA (UTC+8)' },
  { value: 'Asia/Jayapura', label: 'Asia/Jayapura — WIT (UTC+9)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore — SGT (UTC+8)' },
  { value: 'Asia/Kuala_Lumpur', label: 'Asia/Kuala_Lumpur — MYT (UTC+8)' },
  { value: 'Asia/Bangkok', label: 'Asia/Bangkok — ICT (UTC+7)' },
  { value: 'Asia/Manila', label: 'Asia/Manila — PHT (UTC+8)' },
  { value: 'Asia/Hong_Kong', label: 'Asia/Hong_Kong — HKT (UTC+8)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo — JST (UTC+9)' },
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai — CST (UTC+8)' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata — IST (UTC+5:30)' },
  { value: 'Europe/London', label: 'Europe/London — GMT/BST' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin — CET/CEST' },
  { value: 'America/New_York', label: 'America/New_York — ET' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles — PT' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney — AEST/AEDT' },
];

export default function Admin() {
  const { user, logout } = useAuth();
  const { section } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeSection = SECTIONS.some((s) => s.path === section) ? section : null;
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Applications filter state — synced to URL params when on applications section
  const [appBuFilterIds, setAppBuFilterIds] = useState(() => {
    const raw = searchParams.get('bu');
    return raw ? raw.split(',').filter(Boolean) : [];
  });
  const [appBuFilterIncludeGlobal, setAppBuFilterIncludeGlobal] = useState(() => {
    return searchParams.get('global') === '1';
  });
  const [appSearchQuery, setAppSearchQuery] = useState(() => {
    return searchParams.get('q') || '';
  });
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    icon_url: '',
    target_url: '',
    target_bu_ids: [],
    sso_mode: 'none',
    oauth_client_id: '',
    oidc_redirect_uris: '',
  });
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [iconUploading, setIconUploading] = useState(false);
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [domains, setDomains] = useState([]);
  const [domainForm, setDomainForm] = useState({ domain: '' });
  const [showDomainForm, setShowDomainForm] = useState(false);
  const [editingDomain, setEditingDomain] = useState(null);
  const [domainDeleteConfirm, setDomainDeleteConfirm] = useState(null);
  const [domainSaving, setDomainSaving] = useState(false);
  const [businessUnits, setBusinessUnits] = useState([]);
  const [busLoading, setBusLoading] = useState(true);
  const [buForm, setBuForm] = useState({ name: '' });
  const [showBuForm, setShowBuForm] = useState(false);
  const [editingBu, setEditingBu] = useState(null);
  const [buDeleteConfirm, setBuDeleteConfirm] = useState(null);
  const [buSaving, setBuSaving] = useState(false);
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [userEdit, setUserEdit] = useState(null);
  const [userEditForm, setUserEditForm] = useState({ role: 'Employee', business_unit_id: '' });
  const [userEditSaving, setUserEditSaving] = useState(false);
  const [showAddUserForm, setShowAddUserForm] = useState(false);
  const [addUserForm, setAddUserForm] = useState({ email: '', password: '', password_retype: '', role: 'Employee', business_unit_id: '' });
  const [addUserSaving, setAddUserSaving] = useState(false);
  const [userDeactivateConfirm, setUserDeactivateConfirm] = useState(null);
  const [resetPasswordResult, setResetPasswordResult] = useState(null);
  const [ssoPrelinkResult, setSsoPrelinkResult] = useState(null);
  const [ssoEventsUser, setSsoEventsUser] = useState(null);
  const [ssoEvents, setSsoEvents] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsDays, setAnalyticsDays] = useState(30);
  const [bugReports, setBugReports] = useState([]);
  const [bugFilter, setBugFilter] = useState('open');
  const [passwordExpiryDays, setPasswordExpiryDays] = useState(0);
  const [minPasswordLength, setMinPasswordLength] = useState(6);
  const [requireUppercase, setRequireUppercase] = useState(true);
  const [requireLowercase, setRequireLowercase] = useState(true);
  const [requireNumber, setRequireNumber] = useState(true);
  const [requireSymbol, setRequireSymbol] = useState(true);
  const [passwordHistoryCount, setPasswordHistoryCount] = useState(5);
  const [maxLoginAttempts, setMaxLoginAttempts] = useState(5);
  const [lockoutDurationMins, setLockoutDurationMins] = useState(30);
  const [loginMfaBypassMode, setLoginMfaBypassMode] = useState('rolling_24h');
  const [loginMfaBypassHours, setLoginMfaBypassHours] = useState(24);
  const [loginMfaBypassTimezone, setLoginMfaBypassTimezone] = useState('UTC');
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policySaving, setPolicySaving] = useState(false);
  const [policySuccess, setPolicySuccess] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [userMoreMenuId, setUserMoreMenuId] = useState(null);

  // Auto-dismiss success banner after 3s
  useEffect(() => {
    if (!successMessage) return;
    const t = setTimeout(() => setSuccessMessage(''), 3000);
    return () => clearTimeout(t);
  }, [successMessage]);

  // Clear section-level error when navigating between sections
  useEffect(() => {
    setError('');
    setSuccessMessage('');
  }, [activeSection]);

  // Applications + BUs load eagerly — BUs are shared across sections (forms, filters)
  useEffect(() => {
    if (user?.role !== 'Admin') return;
    apiRequest('/api/applications')
      .then((data) => setApplications(data.applications || []))
      .catch((err) => setError(err.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [user?.role]);

  // Domains — load only when on domains section
  useEffect(() => {
    if (user?.role !== 'Admin' || activeSection !== 'domains') return;
    apiRequest('/api/allowed-domains', {})
      .then((data) => setDomains(data.allowed_domains || []))
      .catch(() => setDomains([]))
      .finally(() => setDomainsLoading(false));
  }, [user?.role, activeSection]);

  useEffect(() => {
    if (user?.role !== 'Admin') return;
    apiRequest('/api/business-units', {})
      .then((data) => setBusinessUnits(data.business_units || []))
      .catch(() => setBusinessUnits([]))
      .finally(() => setBusLoading(false));
  }, [user?.role]);

  // Users — load only when on users section
  useEffect(() => {
    if (user?.role !== 'Admin' || activeSection !== 'users') return;
    apiRequest('/api/users', {})
      .then((data) => setUsers(data.users || []))
      .catch(() => setUsers([]))
      .finally(() => setUsersLoading(false));
  }, [user?.role, activeSection]);

  // Analytics — load only when on analytics section (re-load when the window changes)
  useEffect(() => {
    if (user?.role !== 'Admin' || activeSection !== 'analytics') return;
    setAnalyticsLoading(true);
    Promise.all([
      apiRequest(`/api/analytics/summary?days=${analyticsDays}`),
      apiRequest(`/api/analytics/bug-reports?status=${bugFilter}`),
    ])
      .then(([summary, bugs]) => {
        setAnalytics(summary);
        setBugReports(bugs.reports || []);
      })
      .catch((err) => setError(err.error || 'Failed to load analytics'))
      .finally(() => setAnalyticsLoading(false));
  }, [user?.role, activeSection, analyticsDays, bugFilter]);

  // Password policy — load only when on password-policy section
  useEffect(() => {
    if (user?.role !== 'Admin' || activeSection !== 'password-policy') return;
    setPolicyLoading(true);
    setPolicySuccess('');
    apiRequest('/api/settings/password-policy', {})
      .then((data) => {
        setPasswordExpiryDays(data.password_expiry_days ?? 0);
        setMinPasswordLength(data.min_password_length ?? 6);
        setRequireUppercase(data.require_uppercase ?? true);
        setRequireLowercase(data.require_lowercase ?? true);
        setRequireNumber(data.require_number ?? true);
        setRequireSymbol(data.require_symbol ?? true);
        setPasswordHistoryCount(data.password_history_count ?? 5);
        setMaxLoginAttempts(data.max_login_attempts ?? 5);
        setLockoutDurationMins(data.lockout_duration_mins ?? 30);
        setLoginMfaBypassMode(data.login_mfa_bypass_mode ?? 'rolling_24h');
        setLoginMfaBypassHours(data.login_mfa_bypass_hours ?? 24);
        setLoginMfaBypassTimezone(data.login_mfa_bypass_timezone ?? 'UTC');
      })
      .catch((err) => {
        setPasswordExpiryDays(0);
        setError(err.error || 'Failed to load password policy. Restart the backend so migrations can run.');
      })
      .finally(() => setPolicyLoading(false));
  }, [user?.role, activeSection]);

  // Sync application filter state → URL params (only while on applications section)
  useEffect(() => {
    if (activeSection !== 'applications') return;
    const params = new URLSearchParams(searchParams);
    if (appBuFilterIds.length > 0) {
      params.set('bu', appBuFilterIds.join(','));
    } else {
      params.delete('bu');
    }
    if (appBuFilterIncludeGlobal) {
      params.set('global', '1');
    } else {
      params.delete('global');
    }
    if (appSearchQuery.trim()) {
      params.set('q', appSearchQuery.trim());
    } else {
      params.delete('q');
    }
    setSearchParams(params, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appBuFilterIds, appBuFilterIncludeGlobal, appSearchQuery, activeSection]);

  // Filtered application list (client-side; Phase C wires target_bu_ids[] from junction)
  const filteredApplications = useMemo(() => {
    const q = appSearchQuery.trim().toLowerCase();
    return applications.filter((app) => {
      // Text search
      if (q && !app.name.toLowerCase().includes(q) && !app.target_url.toLowerCase().includes(q)) {
        return false;
      }
      // BU filter
      if (appBuFilterIds.length > 0) {
        const isGlobal = !app.target_bu_id;
        if (isGlobal) return appBuFilterIncludeGlobal;
        return appBuFilterIds.includes(app.target_bu_id);
      }
      return true;
    });
  }, [applications, appBuFilterIds, appBuFilterIncludeGlobal, appSearchQuery]);

  const hasAppFilters = appBuFilterIds.length > 0 || appBuFilterIncludeGlobal || !!appSearchQuery.trim();

  const loginMfaTimezoneOptions = useMemo(() => {
    const known = LOGIN_MFA_BYPASS_TIMEZONES.some((tz) => tz.value === loginMfaBypassTimezone);
    if (loginMfaBypassTimezone && !known) {
      return [{ value: loginMfaBypassTimezone, label: `${loginMfaBypassTimezone} (current)` }, ...LOGIN_MFA_BYPASS_TIMEZONES];
    }
    return LOGIN_MFA_BYPASS_TIMEZONES;
  }, [loginMfaBypassTimezone]);

  function clearAppFilters() {
    setAppBuFilterIds([]);
    setAppBuFilterIncludeGlobal(false);
    setAppSearchQuery('');
  }

  async function handleSavePasswordPolicy(e) {
    e.preventDefault();
    setError('');
    setPolicySuccess('');
    setPolicySaving(true);
    try {
      const payload = {
        password_expiry_days: Math.max(0, Math.min(365, parseInt(String(passwordExpiryDays), 10) || 0)),
        min_password_length: Math.max(6, Math.min(128, parseInt(String(minPasswordLength), 10) || 6)),
        require_uppercase: !!requireUppercase,
        require_lowercase: !!requireLowercase,
        require_number: !!requireNumber,
        require_symbol: !!requireSymbol,
        password_history_count: Math.max(0, Math.min(24, parseInt(String(passwordHistoryCount), 10) || 5)),
        max_login_attempts: Math.max(1, Math.min(10, parseInt(String(maxLoginAttempts), 10) || 5)),
        lockout_duration_mins: Math.max(1, Math.min(1440, parseInt(String(lockoutDurationMins), 10) || 30)),
        login_mfa_bypass_mode: loginMfaBypassMode === 'calendar_day' ? 'calendar_day' : 'rolling_24h',
        login_mfa_bypass_hours: Math.max(1, Math.min(168, parseInt(String(loginMfaBypassHours), 10) || 24)),
        login_mfa_bypass_timezone: String(loginMfaBypassTimezone || 'UTC').trim().slice(0, 64) || 'UTC',
      };
      const data = await apiRequest('/api/settings/password-policy', { method: 'PUT', body: JSON.stringify(payload) });
      if (data.login_mfa_bypass_mode == null) {
        setError('Password policy saved partially. Restart/rebuild the backend so login MFA settings can persist.');
      } else {
        setPolicySuccess('Password policy saved.');
      }
      setPasswordExpiryDays(data.password_expiry_days ?? 0);
      setMinPasswordLength(data.min_password_length ?? 6);
      setRequireUppercase(data.require_uppercase ?? true);
      setRequireLowercase(data.require_lowercase ?? true);
      setRequireNumber(data.require_number ?? true);
      setRequireSymbol(data.require_symbol ?? true);
      setPasswordHistoryCount(data.password_history_count ?? 5);
      setMaxLoginAttempts(data.max_login_attempts ?? 5);
      setLockoutDurationMins(data.lockout_duration_mins ?? 30);
      setLoginMfaBypassMode(data.login_mfa_bypass_mode ?? 'rolling_24h');
      setLoginMfaBypassHours(data.login_mfa_bypass_hours ?? 24);
      setLoginMfaBypassTimezone(data.login_mfa_bypass_timezone ?? 'UTC');
    } catch (err) {
      setError(err.error || 'Failed to save password policy');
    } finally {
      setPolicySaving(false);
    }
  }

  const emptyForm = {
    name: '',
    description: '',
    icon_url: '',
    target_url: '',
    target_bu_ids: [],
    sso_mode: 'none',
    oauth_client_id: '',
    oidc_redirect_uris: '',
  };

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
  }

  function openEdit(app) {
    setEditing(app);
    // Prefer target_bu_ids array; fall back to legacy single target_bu_id
    const buIds = Array.isArray(app.target_bu_ids) && app.target_bu_ids.length > 0
      ? app.target_bu_ids
      : (app.target_bu_id ? [app.target_bu_id] : []);
    setForm({
      name: app.name,
      description: app.description || '',
      icon_url: app.icon_url || '',
      target_url: app.target_url || '',
      target_bu_ids: buIds,
      sso_mode: app.sso_mode === 'oidc' ? 'oidc' : 'none',
      oauth_client_id: app.oauth_client_id || '',
      oidc_redirect_uris: Array.isArray(app.oidc_redirect_uris) ? app.oidc_redirect_uris.join('\n') : '',
    });
    setShowForm(true);
  }

  async function loadDomains() {
    const data = await apiRequest('/api/allowed-domains', {});
    setDomains(data.allowed_domains || []);
  }

  function openAddDomain() {
    setEditingDomain(null);
    setDomainForm({ domain: '' });
    setShowDomainForm(true);
  }

  function openEditDomain(row) {
    setEditingDomain(row);
    setDomainForm({ domain: row.domain });
    setShowDomainForm(true);
  }

  function closeDomainForm() {
    setShowDomainForm(false);
    setEditingDomain(null);
    setDomainForm({ domain: '' });
  }

  async function handleSaveDomain(e) {
    e.preventDefault();
    setError('');
    setDomainSaving(true);
    try {
      const domain = (domainForm.domain || '').trim().toLowerCase().replace(/^@+/, '');
      if (!domain) {
        setError('Domain is required (e.g. example.com)');
        setDomainSaving(false);
        return;
      }
      if (editingDomain) {
        await apiRequest(`/api/allowed-domains/${editingDomain.id}`, {
          method: 'PUT',
          body: JSON.stringify({ domain }),
        });
      } else {
        await apiRequest('/api/allowed-domains', {
          method: 'POST',
          body: JSON.stringify({ domain }),
        });
      }
      await loadDomains();
      closeDomainForm();
    } catch (err) {
      setError(err.error || 'Save failed');
    } finally {
      setDomainSaving(false);
    }
  }

  async function handleDeleteDomain(row) {
    setError('');
    setDomainSaving(true);
    try {
      await apiRequest(`/api/allowed-domains/${row.id}`, { method: 'DELETE' });
      await loadDomains();
      setDomainDeleteConfirm(null);
    } catch (err) {
      setError(err.error || 'Delete failed');
    } finally {
      setDomainSaving(false);
    }
  }

  async function loadBusinessUnits() {
    const data = await apiRequest('/api/business-units', {});
    setBusinessUnits(data.business_units || []);
  }

  function openAddBu() {
    setEditingBu(null);
    setBuForm({ name: '' });
    setShowBuForm(true);
  }

  function openEditBu(row) {
    setEditingBu(row);
    setBuForm({ name: row.name });
    setShowBuForm(true);
  }

  function closeBuForm() {
    setShowBuForm(false);
    setEditingBu(null);
    setBuForm({ name: '' });
  }

  async function handleSaveBu(e) {
    e.preventDefault();
    setError('');
    setBuSaving(true);
    try {
      const name = (buForm.name || '').trim();
      if (!name) {
        setError('Name is required');
        setBuSaving(false);
        return;
      }
      if (editingBu) {
        await apiRequest(`/api/business-units/${editingBu.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
      } else {
        await apiRequest('/api/business-units', { method: 'POST', body: JSON.stringify({ name }) });
      }
      await loadBusinessUnits();
      closeBuForm();
    } catch (err) {
      setError(err.error || 'Save failed');
    } finally {
      setBuSaving(false);
    }
  }

  async function handleDeleteBu(row) {
    setError('');
    setBuSaving(true);
    try {
      await apiRequest(`/api/business-units/${row.id}`, { method: 'DELETE' });
      await loadBusinessUnits();
      setBuDeleteConfirm(null);
    } catch (err) {
      setError(err.error || 'Delete failed');
    } finally {
      setBuSaving(false);
    }
  }

  async function loadUsers() {
    const data = await apiRequest('/api/users', {});
    setUsers(data.users || []);
  }

  function openUserEdit(u) {
    setUserEdit(u);
    setUserEditForm({ role: u.role, business_unit_id: u.business_unit_id || '' });
  }

  async function handleSaveUserEdit(e) {
    e.preventDefault();
    setError('');
    setUserEditSaving(true);
    try {
      const buId = userEditForm.business_unit_id === '' || userEditForm.business_unit_id === '_none'
        ? null
        : userEditForm.business_unit_id;
      await apiRequest(`/api/users/${userEdit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: userEditForm.role, business_unit_id: buId }),
      });
      await loadUsers();
      setUserEdit(null);
      setUserEditForm({ role: 'Employee', business_unit_id: '' });
    } catch (err) {
      setError(err.error || 'Update failed');
    } finally {
      setUserEditSaving(false);
    }
  }

  function openAddUser() {
    setAddUserForm({ email: '', password: '', password_retype: '', role: 'Employee', business_unit_id: '' });
    setShowAddUserForm(true);
    setError('');
  }

  function closeAddUserForm() {
    setShowAddUserForm(false);
    setError('');
  }

  function closeAppForm() {
    setEditing(null);
    setShowForm(false);
    setForm(emptyForm);
  }

  async function handleAddUser(e) {
    e.preventDefault();
    setError('');
    setAddUserSaving(true);
    try {
      const result = await apiRequest('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          email: addUserForm.email.trim(),
          role: addUserForm.role,
          business_unit_id: addUserForm.business_unit_id === '' ? null : addUserForm.business_unit_id,
        }),
      });
      await loadUsers();
      setAddUserForm({ email: '', password: '', password_retype: '', role: 'Employee', business_unit_id: '' });
      closeAddUserForm();
      setSuccessMessage(
        result.activation_email_sent === false
          ? 'User created, but the activation email could not be sent. Check SMTP settings / server logs.'
          : 'Invitation sent. The user will receive an email to set their password.'
      );
    } catch (err) {
      setError(err.error || 'Create failed');
    } finally {
      setAddUserSaving(false);
    }
  }

  async function resolveBug(report, resolved) {
    setError('');
    try {
      await apiRequest(`/api/analytics/bug-reports/${report.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolved }),
      });
      const bugs = await apiRequest(`/api/analytics/bug-reports?status=${bugFilter}`);
      setBugReports(bugs.reports || []);
    } catch (err) {
      setError(err.error || 'Failed to update report');
    }
  }

  async function handleDeactivate() {
    if (!userDeactivateConfirm) return;
    setError('');
    try {
      await apiRequest(`/api/users/${userDeactivateConfirm.id}/deactivate`, { method: 'POST' });
      await loadUsers();
      setUserDeactivateConfirm(null);
    } catch (err) {
      setError(err.error || 'Deactivate failed');
    }
  }

  async function handleResetPassword(u) {
    setError('');
    try {
      const data = await apiRequest(`/api/users/${u.id}/reset-password`, { method: 'POST' });
      setResetPasswordResult({ email: u.email, temporary_password: data.temporary_password });
    } catch (err) {
      setError(err.error || 'Reset password failed');
    }
  }

  async function handleUnlock(u) {
    setError('');
    try {
      await apiRequest(`/api/users/${u.id}/unlock`, { method: 'POST' });
      await loadUsers();
    } catch (err) {
      setError(err.error || 'Unlock failed');
    }
  }

  async function handleGenerateSsoLink(u) {
    setError('');
    try {
      const data = await apiRequest(`/api/users/${u.id}/sso-link/start`, { method: 'POST' });
      setSsoPrelinkResult({ email: u.email, url: data.url, expires_at: data.expires_at });
      await loadUsers();
    } catch (err) {
      setError(err.error || 'Failed to generate SSO link');
    }
  }

  async function handleLoadSsoEvents(u) {
    setError('');
    try {
      const data = await apiRequest(`/api/users/${u.id}/sso-events`, {});
      setSsoEventsUser(u);
      setSsoEvents(data.events || []);
    } catch (err) {
      setError(err.error || 'Failed to load SSO events');
    }
  }

  async function handleAdminUnlinkSso(u) {
    setError('');
    try {
      await apiRequest(`/api/users/${u.id}/sso-unlink`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'admin action' }),
      });
      await loadUsers();
    } catch (err) {
      setError(err.error || 'Failed to unlink SSO');
    }
  }

  function copyPasswordToClipboard() {
    if (!resetPasswordResult?.temporary_password) return;
    navigator.clipboard.writeText(resetPasswordResult.temporary_password);
  }

  async function handleIconFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'];
    if (!allowed.includes(file.type)) {
      setError('Please choose a PNG, JPEG, WebP, or SVG file.');
      return;
    }
    if (file.size > 100 * 1024) {
      setError('Image must be 100 KB or smaller.');
      return;
    }
    setIconUploading(true);
    try {
      const data = await apiUpload('/api/applications/icon-upload', file);
      if (data?.icon_url) {
        setForm((f) => ({ ...f, icon_url: data.icon_url }));
      }
    } catch (err) {
      setError(err.error || 'Icon upload failed');
    } finally {
      setIconUploading(false);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const redirectUris = String(form.oidc_redirect_uris || '')
        .split(/\r?\n|,/)
        .map((v) => v.trim())
        .filter(Boolean);
      const payload = {
        name: form.name,
        description: form.description,
        icon_url: form.icon_url,
        target_url: form.target_url,
        target_bu_ids: form.target_bu_ids || [],
        sso_mode: form.sso_mode === 'oidc' ? 'oidc' : 'none',
        oauth_client_id: form.sso_mode === 'oidc' ? (form.oauth_client_id.trim() || null) : null,
        oidc_redirect_uris: form.sso_mode === 'oidc' ? redirectUris : [],
      };
      if (editing) {
        await apiRequest(`/api/applications/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await apiRequest('/api/applications', { method: 'POST', body: JSON.stringify(payload) });
      }
      const data = await apiRequest('/api/applications', {});
      setApplications(data.applications || []);
      const wasEditing = !!editing;
      closeAppForm();
      setSuccessMessage(wasEditing ? 'Application updated.' : 'Application created.');
    } catch (err) {
      setError(err.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(app) {
    setError('');
    setSaving(true);
    try {
      await apiRequest(`/api/applications/${app.id}`, { method: 'DELETE' });
      setApplications((prev) => prev.filter((a) => a.id !== app.id));
      setDeleteConfirm(null);
    } catch (err) {
      setError(err.error || 'Delete failed');
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (user?.role !== 'Admin') return;
    if (!activeSection) navigate('/admin/domains', { replace: true });
  }, [user?.role, activeSection, navigate]);

  if (user?.role !== 'Admin') {
    return (
      <div style={styles.page}>
        <p>Admin access required.</p>
        <Link to="/">Back to Dashboard</Link>
      </div>
    );
  }

  return (
    <div style={styles.page} className="admin-page">
      <header style={styles.header}>
        <HubLogo title="Admin — Downstream Hub" titleStyle={styles.title} iconSize={36} />
        <div style={styles.userRow}>
          <Link to="/" style={styles.backLink}>Dashboard</Link>
          <span style={styles.userEmail}>{user?.email}</span>
          <button type="button" onClick={logout} className="btn-secondary" style={styles.logoutBtn}>Sign out</button>
        </div>
      </header>
      <div style={styles.layout}>
        <nav style={styles.sidebar}>
          {SECTIONS.map((s) => (
            <Link
              key={s.id}
              to={`/admin/${s.path}`}
              style={activeSection === s.path ? styles.sidebarLinkActive : styles.sidebarLink}
            >
              {s.label}
            </Link>
          ))}
        </nav>
        <main style={styles.main}>
          {error && <div style={styles.error}>{error}</div>}
          {successMessage && <div style={styles.success}>{successMessage}</div>}

          {activeSection === 'domains' && (
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Allowed Domains</h2>
          <p style={styles.sectionDesc}>Only users with these email domains can register (e.g. example.com).</p>
          <div style={styles.toolbar}>
            <button type="button" className="btn-secondary" onClick={openAddDomain}>Add domain</button>
          </div>
          <AdminFormModal
            open={showDomainForm}
            title={editingDomain ? 'Edit domain' : 'Add domain'}
            size="sm"
            onClose={closeDomainForm}
            onSubmit={handleSaveDomain}
            saving={domainSaving}
            savingLabel="Saving…"
          >
            <input
              placeholder="Domain (e.g. example.com)"
              value={domainForm.domain}
              onChange={(e) => setDomainForm((f) => ({ ...f, domain: e.target.value }))}
              required
              style={styles.modalInput}
              autoFocus
            />
          </AdminFormModal>
          {domainsLoading ? (
            <p>Loading…</p>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.tableHeader}>Domain</th>
                  <th style={{ ...styles.tableHeader, width: 150 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((d) => (
                  <tr key={d.id}>
                    <td style={styles.tableCell}>{d.domain}</td>
                    <td style={styles.actionsCell}>
                      <button type="button" className="btn-secondary" onClick={() => openEditDomain(d)}>Edit</button>
                      <button type="button" className="btn-danger" onClick={() => setDomainDeleteConfirm(d)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {domainDeleteConfirm && (
            <AdminModal
              onClose={() => setDomainDeleteConfirm(null)}
              disableClose={domainSaving}
              footer={
                <div style={styles.modalFooterActions}>
                  <button type="button" className="btn-danger" onClick={() => handleDeleteDomain(domainDeleteConfirm)} disabled={domainSaving}>
                    {domainSaving ? 'Deleting…' : 'Delete'}
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setDomainDeleteConfirm(null)}>Cancel</button>
                </div>
              }
            >
              <p>Remove domain &quot;{domainDeleteConfirm.domain}&quot;? New registrations from this domain will be blocked. You cannot delete the last domain.</p>
            </AdminModal>
          )}
        </section>
          )}

          {activeSection === 'business-units' && (
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Departments</h2>
          <p style={styles.sectionDesc}>Map users and applications to departments. Apps with no department are &quot;Global&quot; (visible to all).</p>
          <div style={styles.toolbar}>
            <button type="button" className="btn-secondary" onClick={openAddBu}>Add department</button>
          </div>
          <AdminFormModal
            open={showBuForm}
            title={editingBu ? 'Edit department' : 'Add department'}
            size="sm"
            onClose={closeBuForm}
            onSubmit={handleSaveBu}
            saving={buSaving}
            savingLabel="Saving…"
          >
            <input
              placeholder="Name (e.g. Engineering)"
              value={buForm.name}
              onChange={(e) => setBuForm((f) => ({ ...f, name: e.target.value }))}
              required
              style={styles.modalInput}
              autoFocus
            />
          </AdminFormModal>
          {busLoading ? (
            <p>Loading…</p>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.tableHeader}>Name</th>
                  <th style={{ ...styles.tableHeader, width: 150 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {businessUnits.map((bu) => (
                  <tr key={bu.id}>
                    <td style={styles.tableCell}>{bu.name}</td>
                    <td style={styles.actionsCell}>
                      <button type="button" className="btn-secondary" onClick={() => openEditBu(bu)}>Edit</button>
                      <button type="button" className="btn-danger" onClick={() => setBuDeleteConfirm(bu)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {buDeleteConfirm && (
            <AdminModal
              onClose={() => setBuDeleteConfirm(null)}
              disableClose={buSaving}
              footer={
                <div style={styles.modalFooterActions}>
                  <button type="button" className="btn-danger" onClick={() => handleDeleteBu(buDeleteConfirm)} disabled={buSaving}>
                    {buSaving ? 'Deleting…' : 'Delete'}
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setBuDeleteConfirm(null)}>Cancel</button>
                </div>
              }
            >
              <p>Delete department &quot;{buDeleteConfirm.name}&quot;? Users and apps linked to it will be unassigned.</p>
            </AdminModal>
          )}
        </section>
          )}

          {activeSection === 'users' && (
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Users</h2>
          <p style={styles.sectionDesc}>Create users, assign roles and departments, deactivate users, or reset passwords. Copy the new password after reset to pass it to the user.</p>
          <div style={styles.toolbar}>
            <button type="button" className="btn-secondary" onClick={openAddUser}>Add user</button>
          </div>
          <AdminFormModal
            open={showAddUserForm}
            title="New user"
            size="md"
            onClose={closeAddUserForm}
            onSubmit={handleAddUser}
            saving={addUserSaving}
            saveLabel="Send invitation"
            savingLabel="Sending…"
          >
            <p style={styles.inviteHint}>
              The user will receive an email to verify their address and set their own password. No password is set here.
            </p>
            <input
              type="email"
              placeholder="Email"
              value={addUserForm.email}
              onChange={(e) => setAddUserForm((f) => ({ ...f, email: e.target.value }))}
              style={styles.modalInput}
              required
              autoFocus
            />
            <select
              value={addUserForm.role}
              onChange={(e) => setAddUserForm((f) => ({ ...f, role: e.target.value }))}
              style={styles.modalInput}
            >
              <option value="Employee">Employee</option>
              <option value="Admin">Admin</option>
            </select>
            <select
              value={addUserForm.business_unit_id || '_none'}
              onChange={(e) => setAddUserForm((f) => ({ ...f, business_unit_id: e.target.value === '_none' ? '' : e.target.value }))}
              style={styles.modalInput}
            >
              <option value="_none">— No department —</option>
              {businessUnits.map((bu) => (
                <option key={bu.id} value={bu.id}>{bu.name}</option>
              ))}
            </select>
          </AdminFormModal>
          {usersLoading ? (
            <p>Loading…</p>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.tableHeader}>Email</th>
                  <th style={styles.tableHeader}>Role</th>
                  <th style={styles.tableHeader}>Department</th>
                  <th style={styles.tableHeader}>Status</th>
                  <th style={styles.tableHeader}>SSO</th>
                  <th style={{ ...styles.tableHeader, width: 240, minWidth: 240 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td style={styles.tableCell}>
                      {u.email}
                      {u.is_active === false && (
                        <span style={{ marginLeft: 8, display: 'inline-block', padding: '1px 8px', borderRadius: '999px', background: '#FEF3C7', color: '#92400E', fontSize: 'var(--text-xs)', fontWeight: 600 }}>
                          Pending activation
                        </span>
                      )}
                    </td>
                    <td style={styles.tableCell}>{u.role}</td>
                    <td style={styles.tableCell}>{u.business_unit_name || '—'}</td>
                    <td style={styles.tableCell}>{u.locked_until && new Date(u.locked_until) > new Date() ? 'Locked' : '—'}</td>
                    <td style={styles.tableCell}>{u.oidc_linked ? 'Linked' : 'Not linked'}</td>
                    <td style={styles.actionsCell}>
                      <button type="button" className="btn-secondary btn-compact" onClick={() => openUserEdit(u)}>Edit</button>
                      {u.locked_until && new Date(u.locked_until) > new Date() && (
                        <button type="button" className="btn-secondary btn-compact" onClick={() => handleUnlock(u)}>Unlock</button>
                      )}
                      <button type="button" className="btn-danger btn-compact" onClick={() => setUserDeactivateConfirm(u)}>Deactivate</button>
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <button
                          type="button"
                          className="btn-secondary btn-compact"
                          onClick={() => setUserMoreMenuId(userMoreMenuId === u.id ? null : u.id)}
                        >
                          More ▾
                        </button>
                        {userMoreMenuId === u.id && (
                          <div style={styles.moreMenu} onMouseLeave={() => setUserMoreMenuId(null)}>
                            <button type="button" style={styles.moreMenuItem} onClick={() => { handleResetPassword(u); setUserMoreMenuId(null); }}>Reset password</button>
                            <button type="button" style={styles.moreMenuItem} onClick={() => { handleGenerateSsoLink(u); setUserMoreMenuId(null); }}>Generate SSO link</button>
                            <button type="button" style={styles.moreMenuItem} onClick={() => { handleLoadSsoEvents(u); setUserMoreMenuId(null); }}>View SSO history</button>
                            {u.oidc_linked && (
                              <button type="button" style={styles.moreMenuItem} onClick={() => { handleAdminUnlinkSso(u); setUserMoreMenuId(null); }}>Unlink SSO</button>
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {userEdit && (
            <AdminFormModal
              open={!!userEdit}
              title="Edit user"
              size="sm"
              onClose={() => { setUserEdit(null); setUserEditForm({ role: 'Employee', business_unit_id: '' }); }}
              onSubmit={handleSaveUserEdit}
              saving={userEditSaving}
              savingLabel="Saving…"
            >
              <p style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-small)' }}>
                <strong>{userEdit.email}</strong>
              </p>
              <label style={{ display: 'block', marginBottom: 'var(--space-1)', fontSize: 'var(--text-small)' }}>Role</label>
              <select
                value={userEditForm.role}
                onChange={(e) => setUserEditForm((f) => ({ ...f, role: e.target.value }))}
                style={{ ...styles.modalInput, marginBottom: 'var(--space-3)' }}
                autoFocus
              >
                <option value="Employee" disabled={userEdit.id === user?.id && userEdit.role === 'Admin'}>Employee</option>
                <option value="Admin">Admin</option>
              </select>
              <label style={{ display: 'block', marginBottom: 'var(--space-1)', fontSize: 'var(--text-small)' }}>Department</label>
              <select
                value={userEditForm.business_unit_id === null || userEditForm.business_unit_id === undefined || userEditForm.business_unit_id === '' ? '_none' : userEditForm.business_unit_id}
                onChange={(e) => setUserEditForm((f) => ({ ...f, business_unit_id: e.target.value === '_none' ? '' : e.target.value }))}
                style={styles.modalInput}
              >
                <option value="_none">None</option>
                {businessUnits.map((bu) => (
                  <option key={bu.id} value={bu.id}>{bu.name}</option>
                ))}
              </select>
            </AdminFormModal>
          )}
          {userDeactivateConfirm && (
            <AdminModal
              onClose={() => setUserDeactivateConfirm(null)}
              footer={
                <div style={styles.modalFooterActions}>
                  <button type="button" className="btn-danger" onClick={handleDeactivate}>Deactivate</button>
                  <button type="button" className="btn-secondary" onClick={() => setUserDeactivateConfirm(null)}>Cancel</button>
                </div>
              }
            >
              <p>Deactivate user <strong>{userDeactivateConfirm.email}</strong>? They will not be able to log in.</p>
            </AdminModal>
          )}
          {resetPasswordResult && (
            <AdminModal
              onClose={() => setResetPasswordResult(null)}
              footer={
                <div style={styles.modalFooterActions}>
                  <button type="button" className="btn-secondary" onClick={() => setResetPasswordResult(null)}>Close</button>
                </div>
              }
            >
              <p>Password reset for <strong>{resetPasswordResult.email}</strong>. Copy the password and pass it to the user (no email sent):</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
                <input
                  type="text"
                  readOnly
                  value={resetPasswordResult.temporary_password}
                  style={{ ...styles.modalInput, flex: 1, marginBottom: 0, fontFamily: 'monospace' }}
                />
                <button type="button" className="btn-secondary" onClick={copyPasswordToClipboard}>Copy</button>
              </div>
            </AdminModal>
          )}
          {ssoPrelinkResult && (
            <AdminModal
              onClose={() => setSsoPrelinkResult(null)}
              footer={
                <div style={styles.modalFooterActions}>
                  <button type="button" className="btn-secondary" onClick={() => navigator.clipboard.writeText(ssoPrelinkResult.url)}>Copy link</button>
                  <button type="button" className="btn-secondary" onClick={() => setSsoPrelinkResult(null)}>Close</button>
                </div>
              }
            >
              <p>Prelink URL generated for <strong>{ssoPrelinkResult.email}</strong>.</p>
              <input type="text" readOnly value={ssoPrelinkResult.url} style={{ ...styles.modalInput, marginBottom: 0 }} />
            </AdminModal>
          )}
          {ssoEventsUser && (
            <AdminModal
              size="xl"
              scrollable
              onClose={() => setSsoEventsUser(null)}
              title={`SSO events — ${ssoEventsUser.email}`}
              footer={
                <div style={styles.modalFooterActions}>
                  <button type="button" className="btn-secondary" onClick={() => setSsoEventsUser(null)}>Close</button>
                </div>
              }
            >
              {ssoEvents.length === 0 ? <p style={styles.helpText}>No events recorded.</p> : (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.tableHeader}>Time</th>
                      <th style={styles.tableHeader}>Mode</th>
                      <th style={styles.tableHeader}>Event</th>
                      <th style={styles.tableHeader}>Status</th>
                      <th style={styles.tableHeader}>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ssoEvents.map((ev) => (
                      <tr key={ev.id}>
                        <td style={styles.tableCell}>{new Date(ev.created_at).toLocaleString()}</td>
                        <td style={styles.tableCell}>{ev.mode}</td>
                        <td style={styles.tableCell}>{ev.event_type}</td>
                        <td style={styles.tableCell}>{ev.status}</td>
                        <td style={styles.tableCell}>{ev.reason_code || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </AdminModal>
          )}
        </section>
          )}

          {activeSection === 'applications' && (
        <>
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Applications</h2>
          <p style={styles.sectionDesc}>Manage internal apps and who can see them.</p>
        </section>
        <div style={styles.appToolbar}>
          <button type="button" className="btn-secondary" onClick={openCreate}>Add application</button>
          <div style={styles.appToolbarFilters}>
            <input
              type="search"
              placeholder="Search by name or URL…"
              value={appSearchQuery}
              onChange={(e) => setAppSearchQuery(e.target.value)}
              style={styles.appSearchInput}
              aria-label="Search applications"
            />
            <MultiSelectDropdown
              options={businessUnits.map((bu) => ({ id: bu.id, label: bu.name }))}
              selected={appBuFilterIds}
              onChange={setAppBuFilterIds}
              placeholder="Filter by Department"
              includeAllOption
              includeGlobal={appBuFilterIncludeGlobal}
              onIncludeGlobalChange={setAppBuFilterIncludeGlobal}
            />
            {hasAppFilters && (
              <button type="button" className="btn-secondary" onClick={clearAppFilters}>
                Clear filters
              </button>
            )}
          </div>
        </div>
        {!loading && applications.length > 0 && (
          <p style={styles.appResultCount}>
            {filteredApplications.length === applications.length
              ? `${applications.length} application${applications.length === 1 ? '' : 's'}`
              : `Showing ${filteredApplications.length} of ${applications.length} applications`}
          </p>
        )}

        <AdminFormModal
          open={showForm}
          title={editing ? 'Edit application' : 'New application'}
          size="xl"
          onClose={closeAppForm}
          onSubmit={handleSave}
          saving={saving || iconUploading}
          savingLabel="Saving…"
        >
            <label style={styles.label} htmlFor="app-name">App name</label>
            <input
              id="app-name"
              placeholder="e.g. Jetty Planning System"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
              autoComplete="off"
              style={styles.modalInput}
            />
            <label style={styles.label} htmlFor="app-target-url">
              Target URL <span style={{ color: 'var(--color-destructive)' }} aria-hidden="true">*</span>
            </label>
            <input
              id="app-target-url"
              placeholder="https://app.example.com"
              value={form.target_url}
              onChange={(e) => setForm((f) => ({ ...f, target_url: e.target.value }))}
              required
              type="url"
              inputMode="url"
              autoComplete="off"
              aria-required="true"
              style={styles.modalInput}
            />
            <label style={styles.label} htmlFor="app-description">Description</label>
            <input
              id="app-description"
              placeholder="Optional short description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              style={styles.modalInput}
            />
            <label style={styles.label}>Application icon</label>
            <ApplicationIconField
              iconUrl={form.icon_url}
              appName={form.name}
              onIconUrlChange={(icon_url) => setForm((f) => ({ ...f, icon_url }))}
              onFileSelect={handleIconFile}
              uploading={iconUploading}
              disabled={saving}
            />
            <label style={styles.label}>Target Departments</label>
            <MultiSelectDropdown
              options={businessUnits.map((bu) => ({ id: bu.id, label: bu.name }))}
              selected={form.target_bu_ids || []}
              onChange={(ids) => setForm((f) => ({ ...f, target_bu_ids: ids }))}
              placeholder="Global (all users)"
            />
            <p style={styles.helpText}>
              Leave empty to make this app visible to <strong>all users</strong> (Global). Select one or more departments to restrict visibility.
            </p>
            <div style={styles.subSection}>
              <h4 style={styles.subSectionTitle}>SSO settings</h4>
              <p style={styles.helpText}>
                {form.sso_mode === 'oidc'
                  ? 'Configure these when this app uses strict OIDC SSO.'
                  : 'Opens the target URL directly. No SSO hand-off.'}
              </p>
              <label style={styles.label}>SSO Mode</label>
              <select
                value={form.sso_mode || 'none'}
                onChange={(e) => setForm((f) => ({ ...f, sso_mode: e.target.value }))}
                style={styles.modalInput}
              >
                <option value="none">Without SSO</option>
                <option value="oidc">OIDC (strict)</option>
              </select>
              {form.sso_mode === 'oidc' && (
                <>
              <label style={styles.label}>OAuth Client ID</label>
              <input
                placeholder="e.g. jps-web-client"
                value={form.oauth_client_id || ''}
                onChange={(e) => setForm((f) => ({ ...f, oauth_client_id: e.target.value }))}
                style={styles.modalInput}
              />
              <label style={styles.label}>OIDC Redirect URIs</label>
              <textarea
                placeholder="One per line, e.g.&#10;http://localhost:3001/auth/callback"
                value={form.oidc_redirect_uris || ''}
                onChange={(e) => setForm((f) => ({ ...f, oidc_redirect_uris: e.target.value }))}
                rows={4}
                style={styles.modalTextarea}
              />
              <p style={styles.helpText}>You can enter one URI per line (or comma-separated).</p>
                </>
              )}
            </div>
        </AdminFormModal>

        {loading ? (
          <p>Loading…</p>
        ) : applications.length === 0 ? (
          <div style={styles.emptyState}>
            <p style={styles.emptyStateText}>No applications yet. Add your first internal app to get started.</p>
            <button type="button" className="btn-secondary" onClick={openCreate}>Add application</button>
          </div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>App</th>
                <th style={styles.tableHeader}>Target URL</th>
                <th style={styles.tableHeader}>Visibility</th>
                <th style={{ ...styles.tableHeader, width: 80 }}>SSO</th>
                <th style={{ ...styles.tableHeader, width: 130, minWidth: 130 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredApplications.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ ...styles.tableCell, textAlign: 'center', padding: 'var(--space-5)' }}>
                    <p style={styles.emptyFilterText}>No applications match your search or filters.</p>
                    <button type="button" className="btn-secondary" onClick={clearAppFilters}>Clear filters</button>
                  </td>
                </tr>
              ) : filteredApplications.map((app) => {
                const iconSrc = resolveIconSrc(app.icon_url);
                return (
                <tr key={app.id}>
                  <td style={styles.tableCell}>
                    <div style={styles.appCellInner}>
                      {iconSrc ? (
                        <img src={iconSrc} alt="" style={styles.tableIconImg} />
                      ) : (
                        <span style={styles.tableIconInitials}>{applicationInitials(app.name)}</span>
                      )}
                      <span style={styles.appName}>{app.name}</span>
                    </div>
                  </td>
                  <td style={{ ...styles.tableCell, ...styles.urlCell }} title={app.target_url}>{app.target_url}</td>
                  <td style={styles.tableCell}>
                    {Array.isArray(app.target_bu_names) && app.target_bu_names.length > 0
                      ? app.target_bu_names.join(', ')
                      : (app.target_bu_name || 'Global')}
                  </td>
                  <td style={styles.tableCell}>
                    <SsoBadge ssoMode={app.sso_mode} />
                  </td>
                  <td style={styles.actionsCell}>
                    <button type="button" className="btn-secondary" onClick={() => openEdit(app)}>Edit</button>
                    <button type="button" style={styles.deleteLinkBtn} onClick={() => setDeleteConfirm(app)}>Delete</button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {deleteConfirm && (
          <AdminModal
            onClose={() => setDeleteConfirm(null)}
            disableClose={saving}
            footer={
              <div style={styles.modalFooterActions}>
                <button type="button" className="btn-danger" onClick={() => handleDelete(deleteConfirm)} disabled={saving}>
                  {saving ? 'Deleting…' : 'Delete'}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              </div>
            }
          >
            <p>Delete &quot;{deleteConfirm.name}&quot;? This cannot be undone.</p>
          </AdminModal>
        )}
        </>
          )}

          {activeSection === 'analytics' && (
        <section style={styles.section}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <h2 style={styles.sectionTitle}>Analytic</h2>
            <select
              value={analyticsDays}
              onChange={(e) => setAnalyticsDays(parseInt(e.target.value, 10))}
              style={styles.modalInput}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </div>

          {analyticsLoading && <p>Loading analytics…</p>}

          {!analyticsLoading && analytics && (
            <>
              <div style={an.kpiGrid}>
                <div style={an.kpi}><div style={an.kpiNum}>{analytics.overview.active_users}</div><div style={an.kpiLabel}>Active users</div></div>
                <div style={an.kpi}><div style={an.kpiNum}>{analytics.overview.total_launches}</div><div style={an.kpiLabel}>App opens</div></div>
                <div style={an.kpi}><div style={an.kpiNum}>{analytics.overview.total_sessions}</div><div style={an.kpiLabel}>Hub sessions</div></div>
                <div style={an.kpi}><div style={an.kpiNum}>{Number(analytics.overview.avg_session_minutes)}m</div><div style={an.kpiLabel}>Avg session</div></div>
                <div style={an.kpi}><div style={an.kpiNum}>{(Number(analytics.overview.total_minutes) / 60).toFixed(1)}h</div><div style={an.kpiLabel}>Total time in Hub</div></div>
                <div style={an.kpi}><div style={{ ...an.kpiNum, color: analytics.bugCounts.open > 0 ? 'var(--color-destructive)' : undefined }}>{analytics.bugCounts.open}</div><div style={an.kpiLabel}>Open bug reports</div></div>
              </div>

              <div style={an.twoCol}>
                <div style={an.panel}>
                  <h3 style={an.h3}>Most-used applications</h3>
                  {analytics.topApps.length === 0 ? <p style={an.empty}>No app opens in this period.</p> : (
                    <table style={an.table}>
                      <thead><tr><th style={an.th}>Application</th><th style={an.thR}>Opens</th><th style={an.thR}>Users</th></tr></thead>
                      <tbody>
                        {analytics.topApps.map((a) => (
                          <tr key={a.id}><td style={an.td}>{a.name}</td><td style={an.tdR}>{a.launches}</td><td style={an.tdR}>{a.unique_users}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div style={an.panel}>
                  <h3 style={an.h3}>Most active users</h3>
                  {analytics.topUsers.length === 0 ? <p style={an.empty}>No activity in this period.</p> : (
                    <table style={an.table}>
                      <thead><tr><th style={an.th}>User</th><th style={an.thR}>Opens</th><th style={an.thR}>Sessions</th><th style={an.thR}>Minutes</th></tr></thead>
                      <tbody>
                        {analytics.topUsers.map((u) => (
                          <tr key={u.id}><td style={an.td}>{u.email}</td><td style={an.tdR}>{u.launches}</td><td style={an.tdR}>{u.sessions}</td><td style={an.tdR}>{Number(u.minutes)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              <div style={{ ...an.panel, marginTop: 'var(--space-3)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <h3 style={an.h3}>Bug reports &amp; errors</h3>
                  <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                    {['open', 'resolved', ''].map((s) => (
                      <button
                        key={s || 'all'}
                        type="button"
                        onClick={() => setBugFilter(s)}
                        style={bugFilter === s ? an.tabActive : an.tab}
                      >
                        {s === '' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                {bugReports.length === 0 ? <p style={an.empty}>No reports.</p> : (
                  <table style={an.table}>
                    <thead><tr><th style={an.th}>Type</th><th style={an.th}>Message</th><th style={an.th}>Reporter</th><th style={an.th}>When</th><th style={an.th}></th></tr></thead>
                    <tbody>
                      {bugReports.map((b) => (
                        <tr key={b.id}>
                          <td style={an.td}>
                            <span style={b.kind === 'client_error' ? an.badgeErr : an.badgeRep}>
                              {b.kind === 'client_error' ? 'Error' : 'Report'}
                            </span>
                          </td>
                          <td style={an.td}>
                            <div style={{ maxWidth: 360, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{b.message}</div>
                            {b.page_url && <div style={an.pageUrl}>{b.page_url}</div>}
                          </td>
                          <td style={an.td}>{b.reporter_email || '—'}</td>
                          <td style={an.td}>{new Date(b.created_at).toLocaleString()}</td>
                          <td style={an.tdR}>
                            {b.status === 'resolved'
                              ? <button type="button" className="btn-secondary" onClick={() => resolveBug(b, false)}>Reopen</button>
                              : <button type="button" className="btn-primary" onClick={() => resolveBug(b, true)}>Resolve</button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </section>
          )}

          {activeSection === 'password-policy' && (
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Password policy</h2>
          <p style={styles.sectionDesc}>Configure password expiry, complexity, history, and account lockout. Set expiry to <strong>0</strong> to disable.</p>
          {policyLoading ? (
            <p>Loading…</p>
          ) : (
            <form onSubmit={handleSavePasswordPolicy} style={styles.form}>
              {policySuccess && <div style={styles.success}>{policySuccess}</div>}
              <div style={styles.policyGroupFirst}>
                <h3 style={styles.policyGroupTitle}>Password expiry</h3>
                <div style={styles.policyRow}>
                  <div style={styles.policyLabelCol}>
                    <label style={styles.policyLabel}>Password expires after (days)</label>
                  </div>
                  <div style={styles.policyInputCol}>
                    <input type="number" min={0} max={365} value={passwordExpiryDays} onChange={(e) => setPasswordExpiryDays(parseInt(e.target.value, 10) || 0)} style={styles.policyInput} />
                  </div>
                </div>
              </div>
              <div style={styles.policyGroup}>
                <h3 style={styles.policyGroupTitle}>Password requirements</h3>
                <div style={styles.policyRow}>
                  <div style={styles.policyLabelCol}>
                    <label style={styles.policyLabel}>Minimum password length</label>
                  </div>
                  <div style={styles.policyInputCol}>
                    <input type="number" min={6} max={128} value={minPasswordLength} onChange={(e) => setMinPasswordLength(parseInt(e.target.value, 10) || 6)} style={styles.policyInput} />
                  </div>
                </div>
                <div style={styles.policyRow}>
                  <div style={styles.policyLabelCol}>
                    <label style={styles.policyLabel}>Complexity (require at least one of each)</label>
                  </div>
                  <div style={styles.policyInputCol}>
                    <div style={styles.checkboxRow}>
                      <label style={styles.checkboxLabel}><input type="checkbox" checked={requireUppercase} onChange={(e) => setRequireUppercase(e.target.checked)} /> Uppercase</label>
                      <label style={styles.checkboxLabel}><input type="checkbox" checked={requireLowercase} onChange={(e) => setRequireLowercase(e.target.checked)} /> Lowercase</label>
                      <label style={styles.checkboxLabel}><input type="checkbox" checked={requireNumber} onChange={(e) => setRequireNumber(e.target.checked)} /> Number</label>
                      <label style={styles.checkboxLabel}><input type="checkbox" checked={requireSymbol} onChange={(e) => setRequireSymbol(e.target.checked)} /> Symbol</label>
                    </div>
                  </div>
                </div>
              </div>
              <div style={styles.policyGroup}>
                <h3 style={styles.policyGroupTitle}>Password history</h3>
                <div style={styles.policyRow}>
                  <div style={styles.policyLabelCol}>
                    <label style={styles.policyLabel}>Prevent reuse of last N passwords (0 = disabled)</label>
                  </div>
                  <div style={styles.policyInputCol}>
                    <input type="number" min={0} max={24} value={passwordHistoryCount} onChange={(e) => setPasswordHistoryCount(parseInt(e.target.value, 10) || 0)} style={styles.policyInput} />
                  </div>
                </div>
              </div>
              <div style={styles.policyGroup}>
                <h3 style={styles.policyGroupTitle}>Account lockout</h3>
                <div style={styles.policyRow}>
                  <div style={styles.policyLabelCol}>
                    <label style={styles.policyLabel}>Max login attempts before lockout</label>
                  </div>
                  <div style={styles.policyInputCol}>
                    <input type="number" min={1} max={10} value={maxLoginAttempts} onChange={(e) => setMaxLoginAttempts(parseInt(e.target.value, 10) || 5)} style={styles.policyInput} />
                  </div>
                </div>
                <div style={styles.policyRow}>
                  <div style={styles.policyLabelCol}>
                    <label style={styles.policyLabel}>Lockout duration (minutes)</label>
                  </div>
                  <div style={styles.policyInputCol}>
                    <input type="number" min={1} max={1440} value={lockoutDurationMins} onChange={(e) => setLockoutDurationMins(parseInt(e.target.value, 10) || 30)} style={styles.policyInput} />
                  </div>
                </div>
              </div>
              <div style={styles.policyGroup}>
                <h3 style={styles.policyGroupTitle}>Login MFA bypass</h3>
                <p style={styles.sectionDesc}>After a user verifies via email magic link, the same browser can skip MFA for the configured window.</p>
                <div style={styles.policyRow}>
                  <div style={styles.policyLabelCol}>
                    <label style={styles.policyLabel}>Bypass mode</label>
                  </div>
                  <div style={styles.policyInputCol}>
                    <select value={loginMfaBypassMode} onChange={(e) => setLoginMfaBypassMode(e.target.value)} style={styles.policyInput}>
                      <option value="rolling_24h">Rolling hours from last verification</option>
                      <option value="calendar_day">Same calendar day</option>
                    </select>
                  </div>
                </div>
                {loginMfaBypassMode === 'rolling_24h' && (
                  <div style={styles.policyRow}>
                    <div style={styles.policyLabelCol}>
                      <label style={styles.policyLabel}>Bypass window (hours)</label>
                    </div>
                    <div style={styles.policyInputCol}>
                      <input type="number" min={1} max={168} value={loginMfaBypassHours} onChange={(e) => setLoginMfaBypassHours(parseInt(e.target.value, 10) || 24)} style={styles.policyInput} />
                    </div>
                  </div>
                )}
                {loginMfaBypassMode === 'calendar_day' && (
                  <div style={styles.policyRow}>
                    <div style={styles.policyLabelCol}>
                      <label style={styles.policyLabel}>Calendar timezone (IANA)</label>
                    </div>
                    <div style={styles.policyInputCol}>
                      <select
                        value={loginMfaBypassTimezone}
                        onChange={(e) => setLoginMfaBypassTimezone(e.target.value)}
                        style={styles.policyInput}
                      >
                        {loginMfaTimezoneOptions.map((tz) => (
                          <option key={tz.value} value={tz.value}>{tz.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
              <div style={styles.formActions}>
                <button type="submit" className="btn-secondary" disabled={policySaving}>{policySaving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          )}
        </section>
          )}
        </main>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--color-bg-light)', display: 'flex', flexDirection: 'column' },
  header: { background: 'var(--color-bg-white)', padding: 'var(--space-3) var(--space-4)', boxShadow: 'var(--shadow-sm)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  title: { margin: 0, fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  userRow: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' },
  backLink: { color: 'var(--color-primary)', textDecoration: 'none', fontSize: 'var(--text-small)' },
  userEmail: { fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  logoutBtn: {},
  layout: { display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' },
  sidebar: { width: 200, flexShrink: 0, minHeight: 0, overflowY: 'auto', background: 'var(--color-bg-white)', borderRight: '1px solid var(--color-border-light)', padding: 'var(--space-4) var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' },
  sidebarLink: { padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-charcoal)', textDecoration: 'none', fontSize: 'var(--text-small)', transition: 'background var(--duration-fast)' },
  sidebarLinkActive: { padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-md)', background: 'var(--color-primary)', color: 'var(--color-primary-foreground)', textDecoration: 'none', fontSize: 'var(--text-small)', fontWeight: 'var(--font-weight-medium)' },
  main: { flex: 1, maxWidth: 900, margin: 0, padding: 'var(--space-4)', overflow: 'auto' },
  error: { padding: 'var(--space-3)', background: '#FEE2E2', color: 'var(--color-destructive)', borderRadius: 'var(--radius-sm)', marginBottom: 'var(--space-3)', fontSize: 'var(--text-small)' },
  success: { padding: 'var(--space-3)', background: '#DCFCE7', color: '#166534', borderRadius: 'var(--radius-sm)', marginBottom: 'var(--space-3)', fontSize: 'var(--text-small)' },
  toolbar: { marginBottom: 'var(--space-4)', position: 'relative', zIndex: 1 },
  appToolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 'var(--space-3)',
    marginBottom: 'var(--space-3)',
    position: 'relative',
    zIndex: 1,
  },
  appToolbarFilters: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 'var(--space-2)',
    marginLeft: 'auto',
  },
  appSearchInput: {
    width: 220,
    minWidth: 160,
    padding: 'var(--space-2) var(--space-3)',
    border: '1px solid var(--color-border-medium)',
    borderRadius: 'var(--radius-md)',
    fontSize: 'var(--text-small)',
  },
  appResultCount: {
    margin: '0 0 var(--space-3)',
    fontSize: 'var(--text-xs)',
    color: 'var(--color-text-steel)',
  },
  emptyState: {
    background: 'var(--color-bg-white)',
    border: '1px solid var(--color-border-light)',
    borderRadius: 'var(--radius-md)',
    padding: 'var(--space-6) var(--space-4)',
    textAlign: 'center',
    boxShadow: 'var(--shadow-sm)',
  },
  emptyStateText: {
    margin: '0 0 var(--space-4)',
    fontSize: 'var(--text-small)',
    color: 'var(--color-text-steel)',
  },
  emptyFilterText: {
    margin: '0 0 var(--space-3)',
    fontSize: 'var(--text-small)',
    color: 'var(--color-text-steel)',
  },
  appCellInner: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    minWidth: 0,
  },
  appName: {
    fontWeight: 'var(--font-weight-medium)',
    color: 'var(--color-text-charcoal)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  deleteLinkBtn: {
    padding: 'var(--space-2) var(--space-3)',
    background: 'none',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    fontSize: 'var(--text-small)',
    color: 'var(--color-destructive)',
    cursor: 'pointer',
    fontFamily: 'var(--font-primary)',
  },
  primaryBtn: {},
  form: { background: 'var(--color-bg-white)', padding: 'var(--space-4)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-4)', boxShadow: 'var(--shadow-md)' },
  formTitle: { margin: '0 0 var(--space-3)', fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  input: { display: 'block', width: '100%', maxWidth: 400, padding: 'var(--space-2) var(--space-3)', marginBottom: 'var(--space-3)', border: '1px solid var(--color-border-medium)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-base)' },
  modalInput: { display: 'block', width: '100%', maxWidth: '100%', padding: 'var(--space-2) var(--space-3)', marginBottom: 'var(--space-3)', border: '1px solid var(--color-border-medium)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-base)' },
  modalTextarea: { display: 'block', width: '100%', maxWidth: '100%', padding: 'var(--space-2) var(--space-3)', marginBottom: 'var(--space-3)', border: '1px solid var(--color-border-medium)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-base)', resize: 'vertical', fontFamily: 'inherit' },
  modalFooterActions: { display: 'flex', gap: 'var(--space-2)' },
  formActions: { display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' },
  table: { width: '100%', background: 'var(--color-bg-white)', borderRadius: 'var(--radius-md)', borderCollapse: 'collapse', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--color-border-light)' },
  tableHeader: { borderBottom: '1px solid var(--color-border-light)', padding: 'var(--space-2) var(--space-3)', textAlign: 'left', fontWeight: 'var(--font-weight-medium)', fontSize: 'var(--text-small)', color: 'var(--color-text-charcoal)' },
  tableCell: { padding: 'var(--space-2) var(--space-3)', borderBottom: '1px solid var(--color-border-light)', fontSize: 'var(--text-small)' },
  actionsCell: { padding: 'var(--space-2) var(--space-3)', borderBottom: '1px solid var(--color-border-light)', fontSize: 'var(--text-small)', display: 'flex', flexDirection: 'row', gap: 'var(--space-1)', alignItems: 'center', flexWrap: 'nowrap' },
  urlCell: { fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  section: { marginBottom: 'var(--space-6)' },
  sectionTitle: { margin: '0 0 var(--space-1)', fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  sectionDesc: { margin: '0 0 var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  label: { display: 'block', marginBottom: 'var(--space-1)', fontSize: 'var(--text-small)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text-charcoal)' },
  policyGroupFirst: { marginTop: 0, paddingTop: 0 },
  policyGroup: { marginTop: 'var(--space-4)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--color-border-light)' },
  policyGroupTitle: { margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  checkboxRow: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' },
  checkboxLabel: { fontSize: 'var(--text-small)', color: 'var(--color-text-charcoal)', cursor: 'pointer' },
  policyRow: { display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)', marginBottom: 'var(--space-3)' },
  policyLabelCol: { flex: '0 0 260px', minWidth: 0 },
  policyInputCol: { flex: 1, minWidth: 0 },
  policyLabel: { display: 'block', fontSize: 'var(--text-small)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text-charcoal)', paddingTop: 'var(--space-2)' },
  policyInput: { width: '100%', maxWidth: 120, padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-border-medium)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-base)' },
  helpText: { margin: '0 0 var(--space-3)', fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', maxWidth: 480 },
  subSection: { marginTop: 'var(--space-2)', marginBottom: 'var(--space-2)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--color-border-light)' },
  subSectionTitle: { margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  textarea: { display: 'block', width: '100%', maxWidth: 520, padding: 'var(--space-2) var(--space-3)', marginBottom: 'var(--space-3)', border: '1px solid var(--color-border-medium)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-base)', resize: 'vertical', fontFamily: 'inherit' },
  tableIconImg: { width: 36, height: 36, borderRadius: 8, objectFit: 'cover', display: 'block', flexShrink: 0 },
  tableIconInitials: {
    display: 'inline-flex',
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    background: '#A84335',
    color: '#fff',
    fontWeight: 700,
    fontSize: 11,
    fontFamily: 'var(--font-heading, system-ui, sans-serif)',
    flexShrink: 0,
  },
  moreMenu: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 0,
    zIndex: 50,
    background: 'var(--color-bg-white)',
    border: '1px solid var(--color-border-light)',
    borderRadius: 'var(--radius-md)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
    minWidth: 180,
    padding: 'var(--space-1) 0',
  },
  moreMenuItem: {
    display: 'block',
    width: '100%',
    padding: 'var(--space-2) var(--space-3)',
    background: 'none',
    border: 'none',
    textAlign: 'left',
    fontFamily: 'var(--font-primary)',
    fontSize: 'var(--text-small)',
    color: 'var(--color-text-charcoal)',
    cursor: 'pointer',
  },
  inviteHint: { margin: '0 0 var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
};

// Styles for the Analytic section.
const an = {
  kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--space-3)', marginTop: 'var(--space-3)' },
  kpi: { background: 'var(--color-bg-white)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', textAlign: 'center' },
  kpiNum: { fontSize: '26px', fontWeight: 700, color: 'var(--color-text-charcoal)', lineHeight: 1.1 },
  kpiLabel: { fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', marginTop: '4px' },
  twoCol: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 'var(--space-3)', marginTop: 'var(--space-3)' },
  panel: { background: 'var(--color-bg-white)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' },
  h3: { margin: '0 0 var(--space-2)', fontSize: 'var(--text-body)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-small)' },
  th: { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid var(--color-border)', color: 'var(--color-text-steel)', fontWeight: 'var(--font-weight-semibold)' },
  thR: { textAlign: 'right', padding: '6px 8px', borderBottom: '2px solid var(--color-border)', color: 'var(--color-text-steel)', fontWeight: 'var(--font-weight-semibold)' },
  td: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-charcoal)', verticalAlign: 'top' },
  tdR: { textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-charcoal)' },
  empty: { color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  pageUrl: { fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', marginTop: '2px', wordBreak: 'break-all' },
  tab: { padding: '4px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-bg-white)', fontSize: 'var(--text-small)', cursor: 'pointer', color: 'var(--color-text-steel)' },
  tabActive: { padding: '4px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-primary)', background: 'var(--color-primary)', color: '#fff', fontSize: 'var(--text-small)', cursor: 'pointer' },
  badgeRep: { display: 'inline-block', padding: '2px 8px', borderRadius: '999px', background: '#E0ECFF', color: '#1D4ED8', fontSize: 'var(--text-xs)', fontWeight: 600 },
  badgeErr: { display: 'inline-block', padding: '2px 8px', borderRadius: '999px', background: '#FEE2E2', color: '#B91C1C', fontSize: 'var(--text-xs)', fontWeight: 600 },
};
