import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type VideoHTMLAttributes } from 'react';
import type mpegtsType from 'mpegts.js';
import type HlsType from 'hls.js';
import { continuousStreamURL, probeTransportStream } from './videoContainer';
import { useUILanguage } from '../../app/language';

// Keep a real video element/ref: existing chat, PiP and watch-party controls work
// for both native MP4 and mislabeled MPEG-TS attachments.
export const StreamingVideo = forwardRef<HTMLVideoElement, VideoHTMLAttributes<HTMLVideoElement>>(
  function StreamingVideo({ src, ...props }, forwardedRef) {
    const ref = useRef<HTMLVideoElement>(null);
    const language = useUILanguage();
    const [indexProgress,setIndexProgress] = useState<number | null>(null);
    useImperativeHandle(forwardedRef, () => ref.current!, []);

    useEffect(() => {
      const video = ref.current;
      if (!video || !src) return;
      const controller = new AbortController();
      let player: mpegtsType.Player | undefined;
      let hls: HlsType | undefined;
      let disposed = false;
      const fail = () => { if (!disposed) video.dispatchEvent(new Event('error')); };
      setIndexProgress(null);

      void (async () => {
        let transportStream = false;
        try {
          transportStream = await probeTransportStream(src, controller.signal);
        } catch {
          // External media can play natively even when CORS disallows probing.
          // Native errors still report expired/authenticated/unavailable sources.
        }
        if (disposed) return;
        if (!transportStream) {
          video.src = src;
          return;
        }
        const {waitForIndex,createSeekableHls,Hls} = await import('./seekableHls');
        if (disposed) return;
        if (Hls.isSupported() || video.canPlayType('application/vnd.apple.mpegurl')) {
          try {
            setIndexProgress(0);
            const playlist=await waitForIndex(src,controller.signal,p=>{if(!disposed)setIndexProgress(p);});
            if(disposed)return;
            if (!Hls.isSupported()) {
              video.src=playlist;video.dataset.streamEngine='hls';setIndexProgress(null);return;
            }
            hls=createSeekableHls(video,playlist);
            video.dataset.streamEngine='hls';
            hls.on(Hls.Events.MANIFEST_PARSED,()=>{
              if(!hls||disposed)return;
              hls.startLoad(0);setIndexProgress(null);
              if(video.autoplay)void video.play().catch(()=>{});
            });
            hls.on(Hls.Events.ERROR,(_event,data)=>{if(data.fatal)fail();});
            return;
          } catch {
            if(disposed)return;
            setIndexProgress(-1); // Progressive fallback for unindexable sources.
          }
        }
        const { default: mpegts } = await import('mpegts.js');
        if (disposed) return;
        if (!mpegts.isSupported()) {
          // Safari versions with native MPEG-TS support can use the source.
          video.src = src;
          return;
        }
        mpegts.LoggingControl.enableAll = false;
        player = mpegts.createPlayer({ type: 'mpegts', url: continuousStreamURL(src), isLive: false }, {
          enableWorker: true,
          lazyLoad: true,
          lazyLoadMaxDuration: 30,
          lazyLoadRecoverDuration: 10,
          autoCleanupSourceBuffer: true,
          autoCleanupMaxBackwardDuration: 30,
          autoCleanupMinBackwardDuration: 15,
          stashInitialSize: 128,
        });
        player.on(mpegts.Events.ERROR, fail);
        player.attachMediaElement(video);
        video.dataset.streamEngine = 'mpegts';
        player.load();
        if (video.autoplay) void video.play().catch(() => {});
      })().catch(() => { if (!disposed) fail(); });

      return () => {
        disposed = true;
        controller.abort();
        player?.destroy();
        hls?.destroy();
        delete video.dataset.streamEngine;
        video.removeAttribute('src');
        video.load();
      };
    }, [src]);

    // Do not intercept native seeking events: MSE also uses them internally
    // while appending/cleaning buffers. Custom timeline controls clamp their
    // own user requests instead of feeding corrections back into the engine.
    return <><video {...props} ref={ref} />{indexProgress!==null && <span role="status" className="pointer-events-none absolute top-3 left-3 z-10 rounded-lg bg-black/70 px-2 py-1 text-xs text-white">
      {indexProgress<0 ? (language==='fa'?'پخش پیوسته؛ ایندکس جابه‌جایی در دسترس نیست.':'Progressive playback; seeking index unavailable.') :
        (language==='fa'?'آماده‌سازی نوار زمان':'Preparing video timeline')+` ${Math.round(indexProgress*100)}%`}
    </span>}</>;
  },
);
