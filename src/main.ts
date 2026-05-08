import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import HomePage from './components/HomePage.vue';
import KnowledgeBasePage from './components/KnowledgeBasePage.vue';
import './styles.css';
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
