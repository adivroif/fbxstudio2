
import React from 'react';
import { Language, translations } from '../src/translations';

interface CameraControlsProps {
  onAction: (action: string) => void;
  isPlayingAnimation?: boolean;
  onToggleAnimation?: () => void;
  language: Language;
  hasAnimations?: boolean;
  isSidebarOpen?: boolean;
}

const CameraControls: React.FC<CameraControlsProps> = ({ onAction, isPlayingAnimation, onToggleAnimation, language, hasAnimations, isSidebarOpen }) => {
  const t = translations[language];
  const isRTL = language === 'he' || language === 'ar';

  return (
    <div 
      className="fixed top-1/2 -translate-y-1/2 flex flex-col gap-2 z-[200] right-4 sm:right-6 pointer-events-auto transition-transform duration-500 ease-in-out"
      style={{
        transform: `translateY(-50%) translateX(${isSidebarOpen ? '-340px' : '0'})`
      }}
    >
      {[
        { id: 'zoomIn', icon: 'M12 4v16m8-8H4', label: t.zoomIn },
        { id: 'zoomOut', icon: 'M20 12H4', label: t.zoomOut },
        { id: 'reset', icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15', label: t.resetView },
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
