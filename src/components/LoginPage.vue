<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-title">科研问答 Agent</h1>
      <p class="login-subtitle">登录后使用个人知识库与对话</p>

      <el-tabs v-model="mode" class="login-tabs">
        <el-tab-pane label="登录" name="login" />
        <el-tab-pane label="注册" name="register" />
      </el-tabs>

      <el-form :model="form" label-position="top" @submit.prevent="handleSubmit">
        <el-form-item label="用户名">
          <el-input v-model="form.username" placeholder="请输入用户名" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="至少 6 位"
            show-password
            autocomplete="current-password"
            @keyup.enter="handleSubmit"
          />
        </el-form-item>

        <el-alert v-if="error" :title="error" type="error" :closable="false" class="login-error" />

        <el-button type="primary" class="login-submit" :loading="loading" native-type="submit" @click="handleSubmit">
          {{ mode === 'login' ? '登 录' : '注册并登录' }}
        </el-button>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

const mode = ref<'login' | 'register'>('login');
const loading = ref(false);
const error = ref('');
const form = reactive({ username: '', password: '' });

async function handleSubmit() {
  error.value = '';
  const username = form.username.trim();
  const password = form.password;
  if (!username || !password) {
    error.value = '请输入用户名和密码';
    return;
  }
  if (mode.value === 'register' && password.length < 6) {
    error.value = '密码至少 6 位';
    return;
  }

  loading.value = true;
  try {
    if (mode.value === 'login') {
      await auth.login(username, password);
    } else {
      await auth.register(username, password);
    }
    router.replace('/'); // 登录成功进入主页
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败，请重试';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(160deg, #101418 0%, #1b2230 100%);
  padding: 24px;
}
.login-card {
  width: 380px;
  max-width: 100%;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 14px;
  padding: 28px 28px 20px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}
.login-title {
  font-size: 22px;
  margin: 0 0 4px;
  color: var(--el-text-color-primary);
  text-align: center;
}
.login-subtitle {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  text-align: center;
  margin: 0 0 12px;
}
.login-tabs {
  margin-bottom: 8px;
}
.login-error {
  margin: 8px 0 12px;
}
.login-submit {
  width: 100%;
  margin-top: 4px;
}
</style>
