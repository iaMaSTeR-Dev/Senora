import { useEffect, useRef, useState } from 'react';
import { uiText, useUILanguage } from '../../app/language';

export function MotionImage({ src, alt, className, animate, allowDownload = true, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { animate: boolean; allowDownload?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [approved, setApproved] = useState<string>();
  const lang = useUILanguage();
  const allowed = allowDownload || approved === src || src?.startsWith('blob:');
  useEffect(() => {
    if (animate || !allowed || !src) return;
    const image = new Image(); let cancelled = false;
    image.onload = () => {
      if (!cancelled && canvas.current) {
        canvas.current.width = image.naturalWidth;
        canvas.current.height = image.naturalHeight;
        canvas.current.getContext('2d')?.drawImage(image, 0, 0);
      }
      image.onload = null; image.src = '';
    };
    image.src = src;
    return () => { cancelled = true; image.onload = null; image.src = ''; };
  }, [src, animate, allowed]);
  if (!allowed) return <button type="button" className="rounded-lg bg-slate-700 px-4 py-3 text-xs text-white" onClick={event => {event.stopPropagation();setApproved(src);}}>{uiText('Download',lang)}</button>;
  if (animate) return <img src={src} alt={alt} className={className} {...props} />;
  return <span className="relative inline-block max-w-full">
    <canvas ref={canvas} role="img" aria-label={alt} className={className} />
  </span>;
}

export function MotionVideo({src,autoPlay,allowDownload=true,...props}: React.VideoHTMLAttributes<HTMLVideoElement> & {allowDownload?:boolean}) {
  const video=useRef<HTMLVideoElement>(null);const [approved,setApproved]=useState<string>();const lang=useUILanguage();
  const allowed=allowDownload||approved===src||src?.startsWith('blob:');
  useEffect(()=>{if (!video.current)return;if(autoPlay)video.current.play().catch(()=>{});else video.current.pause();},[src,autoPlay,allowed]);
  if(!allowed)return <button type="button" className="rounded-lg bg-slate-700 px-4 py-3 text-xs text-white" onClick={event=>{event.stopPropagation();setApproved(src);}}>{uiText('Download',lang)}</button>;
  return <video {...props} src={src} ref={video} autoPlay={autoPlay} />;
}
