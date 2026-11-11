import React from 'react';
import { useOnlineStatus } from '@/lib/pwa';
import { WifiOff } from 'lucide-react';

export const OfflineBanner: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="bg-amber-600 text-white px-4 py-2 text-xs font-semibold shadow-md flex items-center justify-center animate-in slide-in-from-top duration-200">
      <div className="max-w-7xl mx-auto flex items-center space-x-2">
        <WifiOff className="w-4 h-4 text-amber-200 shrink-0 animate-pulse" />
        <span>
          <span className="font-bold">オフライン動作中:</span> 端末内の保存データで動作しています。食事の記録やグラフ閲覧はそのまま行えます。
        </span>
      </div>
    </div>
  );
};
