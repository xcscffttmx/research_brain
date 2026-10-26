import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import HomePage from './components/HomePage.vue';
import KnowledgeBasePage from './components/KnowledgeBasePage.vue';
import LoginPage from './components/LoginPage.vue';
import { useAuthStore } from './stores/auth';
import './styles.css';
// 先 EP 暗色变量，再 theme.css 做映射，顺序反了映射会被覆盖
import 'element-plus/theme-chalk/dark/css-vars.css';
import './theme.css';
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css';

const app = createApp(App);
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: LoginPage
    },
    {
      path: '/',
      name: 'home',
      component: HomePage,
      meta: { requiresAuth: true }
    },
    {
      path: '/knowledge-base',
      name: 'knowledge-base',
      component: KnowledgeBasePage,
      meta: { requiresAuth: true }
    }
  ]
});

// 路由守卫：未登录不能进主页/知识库，已登录不显示登录页
router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.name === 'login' && auth.isLoggedIn) {
    return { name: 'home' };
  }
  return true;
});

app.use(createPinia());
app.use(router);
app.mount('#app');
