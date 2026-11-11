import Hls, { XhrLoader, type FragmentLoaderContext, type LoaderContext, type LoaderConfiguration, type LoaderCallbacks } from 'hls.js';
import { FragmentCache } from './fragmentCache';

export function indexedSourceURL(src: string, mode: 'index' | 'playlist'): string | null {
  const url = new URL(src, window.location.href);
  if (!/^https?:$/.test(url.protocol) || !/^\/(api\/v1\/(s|attachments)|s)\/[^/]+$/.test(url.pathname)) return null;
  url.searchParams.delete('download'); url.searchParams.set('stream', mode);
  return url.href;
}

export async function waitForIndex(src: string, signal: AbortSignal, onProgress: (progress: number) => void): Promise<string> {
  const url = indexedSourceURL(src, 'index');
  if (!url) throw Error('No indexed source available');
  while (!signal.aborted) {
    const response = await fetch(url, {signal, cache:'no-store'});
    if (response.status !== 202 && !response.ok) throw Error('Video index unavailable');
    if (!response.headers.get('Content-Type')?.includes('application/json') || Number(response.headers.get('Content-Length'))>65536) {
      await response.body?.cancel(); // Older cores return the movie for this URL.
      throw Error('This server does not provide video indexes');
    }
    const result = await response.json();
    if (result.state === 'ready') return indexedSourceURL(src, 'playlist')!;
    if (response.status !== 202 || result.state !== 'indexing') throw Error('Invalid video index');
    onProgress(Math.max(0,Math.min(1,Number(result.progress)||0)));
    await new Promise<void>((resolve,reject) => {
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => {signal.removeEventListener('abort',onAbort);resolve();},1000);
      signal.addEventListener('abort',onAbort,{once:true});
      if(signal.aborted)onAbort();
    });
  }
  throw signal.reason;
}

export function createSeekableHls(video: HTMLVideoElement, playlist: string): Hls {
  const cache = new FragmentCache();
  const notify = () => {
    video.dataset.cachedRanges = JSON.stringify(cache.ranges());
    video.dataset.cacheBytes = String(cache.bytes);
    video.dataset.cacheHits = String(cache.hits);
    video.dispatchEvent(new Event('progress'));
  };
  class CachedLoader extends XhrLoader {
    declare context: FragmentLoaderContext | null;
    private cachedPending = false;
    override load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
      const key = `${context.url}|${context.rangeStart}|${context.rangeEnd}`;
      const cached = cache.get(key);
      if (cached) {
        this.context = context as FragmentLoaderContext; // installed as fLoader only
        const now = performance.now();
        Object.assign(this.stats, {loaded:cached.byteLength,total:cached.byteLength,chunkCount:1});
        this.stats.loading = {start:now,first:now,end:now};
        this.cachedPending = true;
        queueMicrotask(() => {
          if (!this.cachedPending) return;
          this.cachedPending = false;
          notify();
          callbacks.onSuccess({url:context.url,data:cached},this.stats,context,null);
        });
        return;
      }
      super.load(context,config,{...callbacks,onSuccess:(response,stats,context,details)=>{
        if (response.data instanceof ArrayBuffer) {
          if (context.rangeStart!==undefined && context.rangeEnd!==undefined && response.data.byteLength!==context.rangeEnd-context.rangeStart) {
            callbacks.onError({code:502,text:'Incomplete media fragment'},context,details,stats);return;
          }
          const frag = (context as FragmentLoaderContext).frag;
          cache.put(key,{data:response.data,start:frag.start,duration:frag.duration}); notify();
        }
        callbacks.onSuccess(response,stats,context,details);
      }});
    }
    override abort() { this.cachedPending=false;super.abort(); }
    override destroy() { this.cachedPending=false;super.destroy(); }
  }
  const hls = new Hls({
    enableWorker:true,
    autoStartLoad:false,
    fLoader:CachedLoader,
    maxBufferLength:60,
    maxMaxBufferLength:120,
    maxBufferSize:32*1024*1024,
    backBufferLength:30,
  });
  hls.on(Hls.Events.DESTROYING,()=>{
    cache.clear(); delete video.dataset.cachedRanges;delete video.dataset.cacheBytes;delete video.dataset.cacheHits;
  });
  hls.loadSource(playlist); hls.attachMedia(video);
  return hls;
}

export { Hls };
