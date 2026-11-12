import { useEffect, useState } from 'react';

export function blurActiveElementOnBackdropClick(): void {
  if (typeof document === 'undefined') return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    active.blur();
  }
}

/**
 * モーダル・ドロワーの開閉トランジション（フェード＆スケール / スライド）と
 * DOMアンマウント待機を一元管理する共通カスタムフック (Single Source of Truth)
 */
export function useAnimatedModal(
  isOpen: boolean,
  closeDurationMs = 220
): {
  shouldRender: boolean;
  isVisible: boolean;
  blurActiveElementOnBackdropClick: () => void;
} {
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isVisible, setIsVisible] = useState(isOpen);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          setIsVisible(true);
        });
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    } else {
      setIsVisible(false);
      const timer = setTimeout(() => {
        setShouldRender(false);
      }, closeDurationMs);
      return () => clearTimeout(timer);
    }
  }, [isOpen, closeDurationMs]);

  return {
    shouldRender,
    isVisible,
    blurActiveElementOnBackdropClick,
  };
}
