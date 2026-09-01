import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import HomePage from './components/HomePage.vue';
import KnowledgeBasePage from './components/KnowledgeBasePage.vue';
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
      path: '/',
      name: 'home',
      component: HomePage,
    },
    {
      path: '/knowledge-base',
      name: 'knowledge-base',
      component: KnowledgeBasePage,
    },
  ],
});

app.use(createPinia());
app.use(router);
app.mount('#app');
