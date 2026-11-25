import { useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { Button, Field, Input, Notice } from '@/components/ui';

export function LoginPage() {
  const { signInWithPassword, signUp, sendMagicLink } = useAuth();
  const [tab, setTab] = useState<'login' | 'signup' | 'magic'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (tab === 'login') setError(await signInWithPassword(email.trim(), password));
      else if (tab === 'signup') {
        const err = await signUp(email.trim(), password, name.trim());
        if (err) setError(err);
        else setInfo('Cuenta creada. Si tu proyecto exige confirmación, revisa tu correo para activarla.');
      } else {
        const err = await sendMagicLink(email.trim());
        if (err) setError(err);
        else setInfo('Te enviamos un enlace de acceso a tu correo.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-brand-800 p-12 text-brand-50 lg:flex">
        <div className="flex items-center gap-3"><img src="/favicon.svg" className="h-10 w-10" alt="" /><span className="font-display text-2xl text-white">CangreVault</span></div>
        <div>
          <p className="font-display text-4xl leading-tight text-white">Tu cuaderno de finanzas,<br />con la precisión de un contador.</p>
          <ul className="mt-6 space-y-2 text-sm text-brand-100">
            <li>· Modo Simple: “entró dinero / salió dinero”.</li>
            <li>· Modo Normal: diario, estado de resultados, tarjeta y conciliación.</li>
            <li>· Tus datos aislados por usuario con seguridad a nivel de fila.</li>
          </ul>
        </div>
        <p className="text-xs text-brand-200">Montos en RD$ con precisión decimal exacta.</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-4">
          <h1 className="font-display text-2xl text-brand-900">{tab === 'signup' ? 'Crear cuenta' : 'Iniciar sesión'}</h1>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
            {([['login', 'Contraseña'], ['magic', 'Enlace por correo'], ['signup', 'Registrarme']] as const).map(([k, l]) => (
              <button type="button" key={k} onClick={() => setTab(k)} className={`flex-1 rounded-md py-1.5 ${tab === k ? 'bg-white font-medium shadow-sm' : 'text-muted'}`}>{l}</button>
            ))}
          </div>
          {tab === 'signup' && <Field label="Nombre">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}</Field>}
          <Field label="Correo">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />}</Field>
          {tab !== 'magic' && (
            <Field label="Contraseña" hint={tab === 'signup' ? 'Mínimo 8 caracteres.' : undefined}>
              {(id) => <Input id={id} type="password" required minLength={tab === 'signup' ? 8 : undefined} value={password}
                onChange={(e) => setPassword(e.target.value)} autoComplete={tab === 'signup' ? 'new-password' : 'current-password'} />}
            </Field>
          )}
          {error && <Notice tone="warn">{error}</Notice>}
          {info && <Notice tone="ok">{info}</Notice>}
          <Button type="submit" className="w-full" loading={busy}>
            {tab === 'login' ? 'Entrar' : tab === 'signup' ? 'Crear cuenta' : 'Enviar enlace'}
          </Button>
        </form>
      </div>
    </div>
  );
}
