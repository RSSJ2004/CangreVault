export function SetupMissingPage() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-16">
      <h1 className="font-display text-3xl text-brand-900">CangreVault necesita configurarse</h1>
      <p className="mt-3 text-muted">
        No se encontraron las variables <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code>.
        La aplicación no simula datos: requiere un proyecto Supabase real.
      </p>
      <ol className="mt-6 list-decimal space-y-2 pl-5 text-sm">
        <li>Crea un proyecto en Supabase y aplica las migraciones de <code>supabase/migrations</code> (<code>supabase db push</code>).</li>
        <li>Copia <code>.env.example</code> a <code>.env.local</code> y completa URL y clave pública (anon).</li>
        <li>Reinicia <code>npm run dev</code>.</li>
      </ol>
      <p className="mt-6 text-sm text-muted">Consulta el README para el paso a paso completo, incluidas las Edge Functions y la clave de Groq.</p>
    </div>
  );
}
