export function Flash({ error, ok }: { error?: string; ok?: string }) {
  if (error)
    return (
      <p className="alert error" role="alert">
        {error}
      </p>
    );
  if (ok)
    return (
      <p className="alert ok" role="status">
        {ok}
      </p>
    );
  return null;
}
