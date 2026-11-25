import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAppState, type Mode } from '@/state/AppState';
import { useAuth } from '@/auth/AuthProvider';
import { cx } from '@/components/ui';
import { SyncIndicator } from './SyncIndicator';
import { ReminderNotifier } from './ReminderNotifier';

interface NavItem { to: string; label: string; icon: string }

const SIMPLE_NAV: NavItem[] = [
  { to: '/simple', label: 'Inicio', icon: '◉' },
  { to: '/simple/movimientos', label: 'Movimientos', icon: '≡' },
  { to: '/asesor', label: 'Asesor', icon: '✦' },
  { to: '/guia', label: 'Guía', icon: '?' },
  { to: '/ajustes', label: 'Ajustes', icon: '⚙' },
];

const NORMAL_NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: '◉' },
  { to: '/diario', label: 'Diario', icon: '≡' },
  { to: '/resultados', label: 'Estado de resultados', icon: '▤' },
  { to: '/tarjeta', label: 'Tarjeta de crédito', icon: '▭' },
  { to: '/recurrentes', label: 'Gastos recurrentes', icon: '↻' },
  { to: '/metas', label: 'Metas de ahorro', icon: '◎' },
  { to: '/simulador', label: 'Simulador', icon: '∿' },
  { to: '/conciliar', label: 'Conciliación', icon: '⇄' },
  { to: '/bancos', label: 'Conexiones bancarias', icon: '⌂' },
  { to: '/importar', label: 'Importar PDF', icon: '⇪' },
  { to: '/exportar', label: 'Exportar Excel', icon: '⇩' },
  { to: '/asesor', label: 'Asesor IA', icon: '✦' },
  { to: '/ajustes', label: 'Configuración', icon: '⚙' },
  { to: '/guia', label: 'Guía y FAQ', icon: '?' },
];

const MOBILE_NORMAL = ['/dashboard', '/diario', '/tarjeta', '/asesor', '/ajustes'];

export function ModeSwitch() {
  const { mode, setMode } = useAppState();
  const navigate = useNavigate();
  const change = (m: Mode) => {
    setMode(m);
    navigate(m === 'simple' ? '/simple' : '/dashboard');
  };
  return (
    <div className="inline-flex rounded-lg bg-brand-900/40 p-0.5 text-xs" role="group" aria-label="Modo de la aplicación">
      {(['simple', 'normal'] as const).map((m) => (
        <button
          key={m}
          onClick={() => change(m)}
          aria-pressed={mode === m}
          className={cx('rounded-md px-3 py-1.5 font-medium transition', mode === m ? 'bg-white text-brand-800' : 'text-brand-100 hover:text-white')}
        >
          {m === 'simple' ? 'Simple' : 'Normal'}
        </button>
      ))}
    </div>
  );
}

export function AppLayout() {
  const { mode } = useAppState();
  const { user, signOut } = useAuth();
  const nav = mode === 'simple' ? SIMPLE_NAV : NORMAL_NAV;
  const mobileNav = mode === 'simple' ? SIMPLE_NAV : NORMAL_NAV.filter((n) => MOBILE_NORMAL.includes(n.to));

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      <ReminderNotifier />
      <aside className="hidden flex-col bg-brand-800 text-brand-50 lg:sticky lg:top-0 lg:flex lg:h-dvh">
        <div className="flex items-center gap-2.5 px-5 pb-4 pt-6">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <div>
            <div className="font-display text-lg leading-none text-white">CangreVault</div>
            <div className="text-[11px] text-brand-200">Finanzas personales</div>
          </div>
        </div>
        <div className="px-5 pb-3"><ModeSwitch /></div>
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/simple'}
              className={({ isActive }) => cx(
                'mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition',
                isActive ? 'bg-white/12 font-medium text-white' : 'text-brand-100 hover:bg-white/5 hover:text-white',
              )}
            >
              <span className="w-4 text-center text-brand-300" aria-hidden>{n.icon}</span>{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 p-4 text-xs">
          <SyncIndicator dark />
          <div className="mt-3 truncate text-brand-200" title={user?.email ?? ''}>{user?.email}</div>
          <button onClick={() => void signOut()} className="mt-1 text-brand-100 underline-offset-2 hover:underline">Cerrar sesión</button>
        </div>
      </aside>

      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 bg-brand-800 px-4 py-3 text-white lg:hidden">
          <div className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span className="font-display text-base">CangreVault</span>
          </div>
          <div className="flex items-center gap-2">
            <SyncIndicator dark compact />
            <ModeSwitch />
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-28 pt-5 sm:px-6 lg:pb-10 lg:pt-8">
          <Outlet />
        </main>
        <nav className="fixed inset-x-0 bottom-0 z-30 grid border-t border-line bg-white/95 backdrop-blur lg:hidden"
          style={{ gridTemplateColumns: `repeat(${mobileNav.length}, minmax(0, 1fr))`, paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {mobileNav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/simple'}
              className={({ isActive }) => cx('flex flex-col items-center gap-0.5 py-2 text-[11px]', isActive ? 'text-brand-700 font-semibold' : 'text-muted')}>
              <span aria-hidden className="text-base leading-none">{n.icon}</span>
              <span className="truncate px-1">{n.label.split(' ')[0]}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
