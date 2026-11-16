import React from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { validateStrongPassword } from '@/contexts/PatientContext';
import { cn } from '@/lib/utils';

interface PasswordStrengthChecklistProps {
  password: string;
  containerTestId?: string;
  itemTestIdPrefix?: string;
  warningTestId?: string;
}

export const PasswordStrengthChecklist: React.FC<PasswordStrengthChecklistProps> = ({
  password,
  containerTestId,
  itemTestIdPrefix,
  warningTestId,
}) => {
  const pwdStrength = validateStrongPassword(password);

  const items = [
    { key: 'minLength', label: '8文字以上', ok: pwdStrength.minLength },
    { key: 'hasUpper', label: '英大文字 (A-Z)', ok: pwdStrength.hasUpper },
    { key: 'hasLower', label: '英小文字 (a-z)', ok: pwdStrength.hasLower },
    { key: 'hasDigit', label: '数字 (0-9)', ok: pwdStrength.hasDigit },
    { key: 'hasSymbol', label: '記号 (!@#$%等)', ok: pwdStrength.hasSymbol },
  ];

  return (
    <div
      data-testid={containerTestId}
      className="mt-2 p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1.5"
    >
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item.key}
            data-testid={itemTestIdPrefix ? `${itemTestIdPrefix}${item.key}` : undefined}
            data-satisfied={item.ok ? 'true' : 'false'}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold border transition-colors',
              item.ok
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-white text-slate-500 border-slate-200'
            )}
          >
            <CheckCircle2
              className={cn(
                'w-3 h-3 shrink-0',
                item.ok ? 'text-emerald-600' : 'text-slate-300'
              )}
            />
            <span>{item.label}</span>
          </span>
        ))}
      </div>
      {password.length > 0 && !pwdStrength.isValid && (
        <p
          data-testid={warningTestId}
          className="text-[11px] font-semibold text-amber-700 flex items-start gap-1"
        >
          <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
          <span>{pwdStrength.errorMessage}</span>
        </p>
      )}
    </div>
  );
};
