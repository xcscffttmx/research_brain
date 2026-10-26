/**
 * 认证状态：Pinia store。
 * 负责：登录 / 注册 / 登出，以及应用启动时从本地存储恢复登录态。
 */

import { defineStore } from 'pinia';
import * as authApi from '@/services/auth';
import { getStoredUser, clearAuth, type AuthUser } from '@/services/http';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    user: getStoredUser(), // 启动时从 localStorage 恢复
    loading: false
  }),
  getters: {
    isLoggedIn: (state) => Boolean(state.user)
  },
  actions: {
    async login(username: string, password: string) {
      this.loading = true;
      try {
        const result = await authApi.login(username, password);
        this.user = result.user;
        return result;
      } finally {
        this.loading = false;
      }
    },
    async register(username: string, password: string) {
      this.loading = true;
      try {
        const user = await authApi.register(username, password);
        // 注册成功后自动登录
        await this.login(username, password);
        return user;
      } finally {
        this.loading = false;
      }
    },
    logout() {
      this.user = null;
      clearAuth();
    }
  }
});
