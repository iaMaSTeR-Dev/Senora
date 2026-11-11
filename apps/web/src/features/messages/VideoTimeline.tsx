import { useEffect, useState, type RefObject } from 'react';
import { useUILanguage } from '../../app/language';
import { videoSeekBounds } from './videoSeeking';
import { formatMediaTime } from './mediaTime';

export function mergedMediaRanges(video: HTMLVideoElement | null): [number,number][] {
  if (!video) return [];
  const ranges: [number,number][] = [];
  for(let i=0;i<video.buffered.length;i++)ranges.push([video.buffered.start(i),video.buffered.end(i)]);
  try {
    for(const range of JSON.parse(video.dataset.cachedRanges||'[]')) {
      if(Array.isArray(range) && range.length===2 && range.every(Number.isFinite) && range[1]>range[0])ranges.push([range[0],range[1]]);
    }
  } catch { /* Native players have no fragment-cache metadata. */ }
  ranges.sort((a,b)=>a[0]-b[0]);
  const merged: [number,number][]=[];
  for(const range of ranges) {
    const last=merged[merged.length-1];
    if(last && range[0]<=last[1]+0.1)last[1]=Math.max(last[1],range[1]);else merged.push([...range]);
  }
  return merged;
}

export function VideoTimeline({videoRef,currentTime,onSeek}: {
  videoRef:RefObject<HTMLVideoElement|null>;currentTime:number;onSeek:(seconds:number)=>void;
}) {
  const language=useUILanguage();
  const [,refresh]=useState(0);
  useEffect(()=>{
    const video=videoRef.current;if(!video)return;
    let frame=0;
    const changed=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;refresh(n=>n+1);});};
    const events=['progress','durationchange','timeupdate','loadedmetadata'];
    for(const event of events)video.addEventListener(event,changed);
    changed();
    return()=>{for(const event of events)video.removeEventListener(event,changed);cancelAnimationFrame(frame);};
  },[videoRef]);
  const [start,end]=videoSeekBounds(videoRef.current);
  const span=end-start||1;
  return <div className="relative flex-1 h-5 flex items-center">
    <div className="pointer-events-none absolute inset-x-0 h-1.5 overflow-hidden rounded-lg bg-slate-700/80" aria-hidden="true">
      {mergedMediaRanges(videoRef.current).map(([a,b],i)=><span key={i} data-buffered-range={`${a}-${b}`} className="absolute h-full bg-slate-300/60" style={{left:`${100*Math.max(0,a-start)/span}%`,width:`${100*Math.max(0,Math.min(b,end)-Math.max(a,start))/span}%`}}/>)}
      <span className="absolute left-0 h-full bg-indigo-500" style={{width:`${100*Math.max(0,Math.min(1,(currentTime-start)/span))}%`}}/>
    </div>
    <input type="range" aria-label={language==='fa'?'موقعیت پخش':'Playback position'} aria-valuetext={formatMediaTime(currentTime)}
      min={start} max={end||1} step={0.1} value={Math.max(start,Math.min(end||1,currentTime))} disabled={end<=start}
      onChange={event=>onSeek(Number(event.target.value))}
      className="relative z-10 w-full h-5 bg-transparent appearance-none cursor-pointer accent-indigo-500 disabled:cursor-wait"/>
  </div>;
}
