
import React from 'react';
import { Language, translations } from '../src/translations';

interface CameraControlsProps {
  onAction: (action: string) => void;
  isPlayingAnimation?: boolean;
  onToggleAnimation?: () => void;
  language: Language;
  hasAnimations?: boolean;
  isSidebarOpen?: boolean;
  onOrbitStart?: (direction: 'up' | 'down' | 'left' | 'right') => void;
  onOrbitEnd?: () => void;
}

const CameraControls: React.FC<CameraControlsProps> = ({ 
  onAction, 
  isPlayingAnimation, 
  onToggleAnimation, 
  language, 
  hasAnimations, 
  isSidebarOpen,
  onOrbitStart,
  onOrbitEnd
}) => {
  const t = translations[language];
  const isRTL = language === 'he' || language === 'ar';

  return (
    <div 
      dir="ltr"
      className="fixed top-[calc(50%-40px)] -translate-y-1/2 flex flex-col gap-3.5 z-[200] right-4 sm:right-6 pointer-events-auto transition-transform duration-500 ease-in-out items-end"
      style={{
        transform: 'translateY(-50%)'
      }}
    >
      {/* Zoom In & Out Controls */}
      <div className="flex flex-col gap-2">
        {[
          { id: 'zoomIn', icon: 'M12 4v16m8-8H4', label: t.zoomIn },
          { id: 'zoomOut', icon: 'M20 12H4', label: t.zoomOut },
        ].map((btn) => (
          <button
            key={btn.id}
            onClick={() => onAction(btn.id)}
            className="w-10 h-10 sm:w-12 sm:h-12 bg-white/90 backdrop-blur-xl border border-black/5 rounded-xl sm:rounded-2xl flex items-center justify-center text-zinc-400 hover:text-yellow-500 hover:bg-white transition-all shadow-2xl group relative"
            title={btn.label}
          >
            <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d={btn.icon} />
            </svg>
            <span className="hidden sm:block absolute px-2 py-1 bg-black text-white text-[8px] font-black uppercase tracking-widest rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap border border-white/10 right-full mr-3">
              {btn.label}
            </span>
          </button>
        ))}
      </div>

      {/* Orbit Direction D-Pad cross */}
      <div className="flex flex-col items-center p-2 bg-white/90 dark:bg-zinc-950/90 backdrop-blur-xl border border-black/5 dark:border-white/5 rounded-2xl sm:rounded-3xl shadow-2xl gap-1">
        {/* Up Arrow */}
        <button
          onPointerDown={() => onOrbitStart?.('up')}
          onPointerUp={onOrbitEnd}
          onPointerLeave={onOrbitEnd}
          onClick={() => onAction('up')}
          className="w-9 h-9 sm:w-11 sm:h-11 bg-zinc-50 dark:bg-zinc-900 border border-black/5 dark:border-white/5 rounded-lg sm:rounded-xl flex items-center justify-center text-zinc-400 hover:text-yellow-500 hover:bg-white dark:hover:bg-zinc-800 transition-all shadow-sm active:scale-90 cursor-pointer"
          title={language === 'he' ? 'סובב למעלה' : 'Rotate Up'}
        >
          <svg className="w-4.5 h-4.5 sm:w-5.5 sm:h-5.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>

        {/* Left, Reset, Right Row */}
        <div className="flex items-center gap-1">
          {/* Left Arrow */}
          <button
            onPointerDown={() => onOrbitStart?.('left')}
            onPointerUp={onOrbitEnd}
            onPointerLeave={onOrbitEnd}
            onClick={() => onAction('left')}
            className="w-9 h-9 sm:w-11 sm:h-11 bg-zinc-50 dark:bg-zinc-900 border border-black/5 dark:border-white/5 rounded-lg sm:rounded-xl flex items-center justify-center text-zinc-400 hover:text-yellow-500 hover:bg-white dark:hover:bg-zinc-800 transition-all shadow-sm active:scale-90 cursor-pointer"
            title={language === 'he' ? 'סובב שמאלה' : 'Rotate Left'}
          >
            <svg className="w-4.5 h-4.5 sm:w-5.5 sm:h-5.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          {/* Reset button inside D-pad center */}
          <button
            onClick={() => onAction('reset')}
            className="w-9 h-9 sm:w-11 sm:h-11 bg-zinc-100 dark:bg-zinc-800 border border-black/5 dark:border-white/5 rounded-lg sm:rounded-xl flex items-center justify-center text-zinc-500 dark:text-zinc-300 hover:text-yellow-500 hover:bg-white dark:hover:bg-zinc-700 transition-all shadow-sm active:scale-90 cursor-pointer"
            title={t.resetView}
          >
            <svg className="w-4.5 h-4.5 sm:w-5.5 sm:h-5.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>

          {/* Right Arrow */}
          <button
            onPointerDown={() => onOrbitStart?.('right')}
            onPointerUp={onOrbitEnd}
            onPointerLeave={onOrbitEnd}
            onClick={() => onAction('right')}
            className="w-9 h-9 sm:w-11 sm:h-11 bg-zinc-50 dark:bg-zinc-900 border border-black/5 dark:border-white/5 rounded-lg sm:rounded-xl flex items-center justify-center text-zinc-400 hover:text-yellow-500 hover:bg-white dark:hover:bg-zinc-800 transition-all shadow-sm active:scale-90 cursor-pointer"
            title={language === 'he' ? 'סובב ימינה' : 'Rotate Right'}
          >
            <svg className="w-4.5 h-4.5 sm:w-5.5 sm:h-5.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {/* Down Arrow */}
        <button
          onPointerDown={() => onOrbitStart?.('down')}
          onPointerUp={onOrbitEnd}
          onPointerLeave={onOrbitEnd}
          onClick={() => onAction('down')}
          className="w-9 h-9 sm:w-11 sm:h-11 bg-zinc-50 dark:bg-zinc-900 border border-black/5 dark:border-white/5 rounded-lg sm:rounded-xl flex items-center justify-center text-zinc-400 hover:text-yellow-500 hover:bg-white dark:hover:bg-zinc-800 transition-all shadow-sm active:scale-90 cursor-pointer"
          title={language === 'he' ? 'סובב למטה' : 'Rotate Down'}
        >
          <svg className="w-4.5 h-4.5 sm:w-5.5 sm:h-5.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Animation Play/Pause */}
      {hasAnimations && onToggleAnimation && (
        <button
          onClick={onToggleAnimation}
          className={`w-10 h-10 sm:w-12 sm:h-12 border border-black/5 rounded-xl sm:rounded-2xl flex items-center justify-center transition-all shadow-2xl group relative ${isPlayingAnimation ? 'bg-purple-500 text-white' : 'bg-white/90 backdrop-blur-xl text-zinc-400 hover:text-purple-400 hover:bg-white'}`}
          title={isPlayingAnimation ? t.stopAnimation : t.playAnimation}
        >
          <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
            {isPlayingAnimation ? (
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
            ) : (
              <path d="M8 5v14l11-7z"/>
            )}
          </svg>
          <span className="hidden sm:block absolute px-2 py-1 bg-black text-white text-[8px] font-black uppercase tracking-widest rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap border border-white/10 right-full mr-3">
            {isPlayingAnimation ? t.stopAnimation : t.playAnimation}
          </span>
        </button>
      )}
    </div>
  );
};

export default CameraControls;
