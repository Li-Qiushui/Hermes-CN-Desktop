import { useNavigate, useLocation } from "react-router-dom";
import { Moon, Search, Sun } from "lucide-react";
import { useTheme } from "@hermes/shared-ui";
import { useCommandPalette } from "@/components/command-palette";
import { HermesLogoMark } from "@/components/brand/hermes-logo-mark";
import { StatusChip } from "./status-chip";
import { TOP_TABS } from "./use-active-top-tab";
import s from "./app-top-bar.module.css";

export function AppTopBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { config: themeConfig, update: updateTheme } = useTheme();
  const { openCommandPalette } = useCommandPalette();
  const isDarkTheme = ["dark", "dark-modern", "dracula", "catppuccin-mocha"].includes(themeConfig.theme);
  const nextTheme = isDarkTheme ? "light-modern" : "dark-modern";
  const ThemeIcon =
    isDarkTheme ? Sun : Moon;
  const themeToggleLabel = `切换到${isDarkTheme ? "浅色" : "深色"}模式`;

  return (
    <header className={s.topbar} data-window-drag data-tauri-drag-region="deep">
      <div className={s.brand} data-no-drag>
        <span className={s.brandText}>
          <HermesLogoMark size={20} />
          <span className={s.wordmark}>Hermes</span>
        </span>
      </div>

      <span className={s.brandDivider} aria-hidden="true" />

      <nav className={s.nav} aria-label="主导航">
        {TOP_TABS.map((tab) => (
          <a
            key={tab.id}
            href={tab.href}
            className={s.navLink}
            data-active={tab.matches(location.pathname) ? "true" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(tab.href);
            }}
          >
            {tab.label}
          </a>
        ))}
      </nav>

      <button
        type="button"
        className={s.search}
        onClick={openCommandPalette}
        title="搜索命令 / 会话 / 文件"
        data-no-drag
      >
        <Search size={12} />
        <span>搜索命令 / 会话 / 文件…</span>
        <span className={s.searchKbd}>⌘ K</span>
      </button>

      <div className={s.actions}>
        <StatusChip />
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => updateTheme({ theme: nextTheme })}
          title={themeToggleLabel}
          aria-label={themeToggleLabel}
          data-theme-mode={themeConfig.theme}
        >
          <ThemeIcon size={16} />
        </button>
      </div>
    </header>
  );
}
