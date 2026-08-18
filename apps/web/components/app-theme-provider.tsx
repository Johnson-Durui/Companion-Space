"use client";

import { App, ConfigProvider } from "antd";
import type { ThemeConfig } from "antd";
import type { ReactNode } from "react";

const appTheme: ThemeConfig = {
  token: {
    colorPrimary: "#28786F",
    colorInfo: "#456B8A",
    colorSuccess: "#2F7A5D",
    colorWarning: "#A5652C",
    colorError: "#B24943",
    colorLink: "#28786F",
    colorText: "#102F34",
    colorTextSecondary: "#63716E",
    colorBgBase: "#F4F0E8",
    colorBgLayout: "#F4F0E8",
    colorBgContainer: "#FFFDF7",
    colorBgElevated: "#FFFFFF",
    colorBorder: "#D2DCD6",
    colorSplit: "#E7ECE7",
    borderRadius: 10,
    borderRadiusLG: 14,
    controlHeight: 44,
    fontSize: 15,
    lineHeight: 1.6,
    boxShadow: "none",
    boxShadowSecondary: "none",
    fontFamily:
      '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif',
  },
  components: {
    Button: {
      primaryShadow: "none",
    },
    Card: {
      boxShadow: "none",
    },
  },
};

export function AppThemeProvider({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={appTheme}>
      <App className="app-provider-root">{children}</App>
    </ConfigProvider>
  );
}
