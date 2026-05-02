import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";

export const RequireAuth = ({
  children,
  adminOnly = false,
  staffOnly = false,
}: {
  children: ReactNode;
  /** Strict admin (blocks teachers) */
  adminOnly?: boolean;
  /** Admin or teacher */
  staffOnly?: boolean;
}) => {
  const { user, role, loading } = useAuth();
  const loc = useLocation();
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground text-sm">{t("common.loading")}</div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: loc }} replace />;
  if (adminOnly && role !== "admin") {
    return <Navigate to={role === "teacher" ? "/admin/dashboard" : "/dashboard"} replace />;
  }
  if (staffOnly && role !== "admin" && role !== "teacher") {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
};
