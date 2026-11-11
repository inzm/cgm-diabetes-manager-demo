import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { UserRole } from '@/types/database';
import { db } from '@/lib/db';
import { isPortfolioMode } from '@/lib/realGlucoseLoader';

export interface PatientContextType {
  currentPatientId: string;
  currentRole: UserRole;
  isReadOnly: boolean;
  hypoThreshold: number;
  hyperThreshold: number;
  setRole: (role: UserRole) => void;
  updateClinicalThresholds: (hypo: number, hyper: number) => void;
}

const PatientContext = createContext<PatientContextType | undefined>(undefined);

// Initial default patient ID (for local-first mode prior to Supabase Auth)
export const DEFAULT_PATIENT_ID = '00000000-0000-0000-0000-000000000001';

export function PatientProvider({ children }: { children: React.ReactNode }) {
  const [currentPatientId] = useState<string>(DEFAULT_PATIENT_ID);
  const [currentRole, setCurrentRole] = useState<UserRole>('patient');
  const [hypoThreshold, setHypoThreshold] = useState<number>(70);
  const [hyperThreshold, setHyperThreshold] = useState<number>(180);

  const isReadOnly = currentRole === 'viewer';

  useEffect(() => {
    // ポートフォリオモードの初期起動時は常に 70 / 180 にリセットされるため、起動直後のIndexedDB競合アクセスを回避
    if (isPortfolioMode()) {
      setHypoThreshold(70);
      setHyperThreshold(180);
      return;
    }
    let active = true;
    db.user_settings
      .get(currentPatientId)
      .then((settings) => {
        if (!active) return;
        if (settings) {
          setHypoThreshold(settings.hypo_threshold || 70);
          setHyperThreshold(settings.hyper_threshold || 180);
        } else {
          setHypoThreshold(70);
          setHyperThreshold(180);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [currentPatientId]);

  const setRole = (role: UserRole) => {
    setCurrentRole(role);
  };

  const updateClinicalThresholds = useCallback((hypo: number, hyper: number) => {
    setHypoThreshold(hypo);
    setHyperThreshold(hyper);
  }, []);

  return (
    <PatientContext.Provider
      value={{
        currentPatientId,
        currentRole,
        isReadOnly,
        hypoThreshold,
        hyperThreshold,
        setRole,
        updateClinicalThresholds,
      }}
    >
      {children}
    </PatientContext.Provider>
  );
}

export function usePatient() {
  const context = useContext(PatientContext);
  if (!context) {
    throw new Error('usePatient must be used within a PatientProvider');
  }
  return context;
}
