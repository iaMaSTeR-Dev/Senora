export function sharedWatchPartyURL(source: string): string {
  if (!source.startsWith('/api/v1/attachments/')) return source;
  const url=new URL(source,'https://senora.invalid');
  for(const parameter of ['auth','token'])url.searchParams.delete(parameter);
  return url.pathname+url.search;
}

export function watchPartyPlaybackURL(source: string, viewerToken: string | null): string {
  const shared=sharedWatchPartyURL(source);
  if (!shared.startsWith('/api/v1/attachments/') || !viewerToken)return shared;
  const url=new URL(shared,'https://senora.invalid');url.searchParams.set('auth',viewerToken);
  return url.pathname+url.search;
}
