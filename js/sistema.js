// sistema.js — auth + sidebar compartilhado entre módulos
// Uso: <script type="module" src="../js/sistema.js" data-modulo="vendas"></script>

import { initializeApp }            from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDJRQYM4K43Bc1Lfg4EhfBz-aNtkPprAs8",
  authDomain: "mr4-ponto.firebaseapp.com",
  projectId: "mr4-ponto",
  storageBucket: "mr4-ponto.firebasestorage.app",
  messagingSenderId: "848211361584",
  appId: "1:848211361584:web:2732e1893122f4a23452f5"
};

const MODULOS = [
  { id: 'vendas',     nome: 'Painel de Vendas', icon: '📊', url: './vendas.html'     },
  { id: 'estoque',    nome: 'Estoque',           icon: '🗄️', url: './estoque.html'    },
  { id: 'financeiro', nome: 'Financeiro',        icon: '💰', url: './financeiro.html' },
  { id: 'catalogo',   nome: 'Catálogo',          icon: '📦', url: 'https://catalogo.mr4distribuidora.com.br' },
  { id: 'expedicao',  nome: 'Expedição',         icon: '🚚', url: './expedicao.html'  },
  { id: 'ponto',      nome: 'Ponto',             icon: '📍', url: './ponto.html'      },
  { id: 'marketing',  nome: 'Marketing',         icon: '📢', url: './marketing.html'  },
  { id: 'garantia',   nome: 'Garantia',          icon: '🛡️', url: './garantia.html'   },
  { id: 'admin',      nome: 'Administração',     icon: '⚙️', url: './admin.html'      },
];

const app  = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db   = getFirestore(app);

// Módulo atual (lido do script tag)
const scriptTag   = document.currentScript || document.querySelector('script[data-modulo]');
const MODULO_ATUAL = scriptTag?.dataset?.modulo || '';

export async function initSistema() {
  return new Promise(resolve => {
    onAuthStateChanged(auth, async user => {
      if (!user) { window.location.href = '../login.html'; return; }

      let perfil = { nome: user.displayName || user.email.split('@')[0], cargo: 'Usuário', modulos: [], admin: false };
      try {
        const snap = await getDoc(doc(db, 'sistema_usuarios', user.uid));
        if (snap.exists()) {
          const d = snap.data();
          perfil = { ...perfil, ...d };
          if (d.admin) perfil.modulos = MODULOS.map(m => m.id);
        }
      } catch(e) {}

      // Verifica permissão
      if (MODULO_ATUAL && !perfil.admin && !perfil.modulos.includes(MODULO_ATUAL)) {
        window.location.href = '../index.html';
        return;
      }

      renderSidebar(perfil, user.email);
      resolve({ user, perfil });
    });
  });
}

function renderSidebar(perfil, email) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const primeiroNome = (perfil.nome || '').split(' ')[0];
  const inicial = primeiroNome[0]?.toUpperCase() || '?';

  let navItems = '';
  MODULOS.forEach(m => {
    const tem = perfil.admin || perfil.modulos.includes(m.id);
    const ativo = m.id === MODULO_ATUAL ? ' active' : '';
    if (tem) {
      navItems += `<a class="nav-item${ativo}" href="${m.url}"><span class="nav-icon">${m.icon}</span>${m.nome}</a>`;
    }
  });

  sidebar.innerHTML = `
    <div class="sidebar-logo">
      <img src="../assets/logo.png" alt="MR4 Distribuidora">
    </div>
    <div class="sidebar-user">
      <div class="user-avatar">${inicial}</div>
      <div class="user-info">
        <div class="user-name">${perfil.nome || email}</div>
        <div class="user-role">${perfil.cargo || 'Usuário'}</div>
      </div>
    </div>
    <nav class="sidebar-nav">
      <div class="nav-section">Módulos</div>
      ${navItems}
    </nav>
    <div class="sidebar-footer">
      <button class="btn-sair" onclick="window._sairSistema()">↩ Sair do sistema</button>
    </div>
  `;

  window._sairSistema = async () => {
    await signOut(auth);
    window.location.href = '../login.html';
  };
}

// CSS compartilhado
export const CSS_SISTEMA = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --orange:   #FF6B1A;
    --orange-dk:#e85d0f;
    --bg:       #F3F4F6;
    --white:    #FFFFFF;
    --text:     #1A1A2E;
    --muted:    #6B7280;
    --border:   #E5E7EB;
    --green:    #10B981;
    --yellow:   #F59E0B;
    --red:      #EF4444;
    --blue:     #3B82F6;
    --sidebar-w:240px;
    --mono:     'JetBrains Mono', monospace;
  }
  body { font-family:'Inter',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; display:flex; }

  /* SIDEBAR */
  .sidebar { width:var(--sidebar-w); background:var(--white); border-right:1px solid var(--border); display:flex; flex-direction:column; position:fixed; top:0; left:0; bottom:0; z-index:100; overflow-y:auto; }
  .sidebar-logo { padding:1.25rem 1.25rem .85rem; border-bottom:1px solid var(--border); }
  .sidebar-logo img { height:32px; object-fit:contain; }
  .sidebar-user { padding:.85rem 1.25rem; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:.65rem; }
  .user-avatar { width:34px; height:34px; border-radius:50%; background:var(--orange); color:#fff; font-weight:700; font-size:.85rem; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .user-info { flex:1; min-width:0; }
  .user-name { font-size:.8rem; font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .user-role { font-size:.65rem; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
  .sidebar-nav { flex:1; padding:.5rem 0; }
  .nav-section { font-size:.6rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:1.2px; padding:.65rem 1.25rem .2rem; }
  .nav-item { display:flex; align-items:center; gap:.6rem; padding:.55rem 1.25rem; font-size:.82rem; font-weight:500; color:var(--muted); text-decoration:none; border-left:3px solid transparent; transition:all .15s; }
  .nav-item:hover { background:var(--bg); color:var(--text); }
  .nav-item.active { background:rgba(255,107,26,.07); color:var(--orange); border-left-color:var(--orange); font-weight:600; }
  .nav-icon { font-size:.95rem; width:18px; text-align:center; }
  .sidebar-footer { padding:.85rem 1.25rem; border-top:1px solid var(--border); }
  .btn-sair { width:100%; padding:.55rem; border:1.5px solid var(--border); border-radius:8px; background:none; font-family:'Inter',sans-serif; font-size:.78rem; font-weight:600; color:var(--muted); cursor:pointer; transition:all .15s; }
  .btn-sair:hover { border-color:var(--red); color:var(--red); }

  /* MAIN */
  .main { margin-left:var(--sidebar-w); flex:1; padding:2rem; min-height:100vh; }
  .page-header { margin-bottom:1.75rem; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:1rem; }
  .page-title { font-size:1.4rem; font-weight:800; letter-spacing:-.3px; }
  .page-sub { font-size:.8rem; color:var(--muted); margin-top:.2rem; }

  /* CARDS */
  .cards-row { display:grid; gap:1rem; margin-bottom:1.5rem; }
  .cards-4 { grid-template-columns:repeat(4,1fr); }
  .cards-3 { grid-template-columns:repeat(3,1fr); }
  .cards-2 { grid-template-columns:repeat(2,1fr); }
  .kpi-card { background:var(--white); border-radius:14px; border:1px solid var(--border); padding:1.25rem 1.5rem; }
  .kpi-label { font-size:.68rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.8px; margin-bottom:.5rem; }
  .kpi-value { font-family:var(--mono); font-size:1.6rem; font-weight:600; color:var(--text); line-height:1; }
  .kpi-sub { font-size:.73rem; color:var(--muted); margin-top:.35rem; }
  .kpi-card.green .kpi-value { color:var(--green); }
  .kpi-card.red   .kpi-value { color:var(--red); }
  .kpi-card.orange .kpi-value { color:var(--orange); }
  .kpi-card.blue  .kpi-value { color:var(--blue); }

  /* SECTION */
  .section { background:var(--white); border-radius:14px; border:1px solid var(--border); padding:1.5rem; margin-bottom:1.25rem; }
  .section-title { font-size:.78rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.8px; margin-bottom:1.25rem; display:flex; align-items:center; gap:.5rem; }

  /* TABLE */
  .data-table { width:100%; border-collapse:collapse; font-size:.83rem; }
  .data-table th { background:var(--bg); padding:.6rem 1rem; text-align:left; font-size:.68rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; border-bottom:1px solid var(--border); }
  .data-table td { padding:.65rem 1rem; border-bottom:1px solid var(--border); color:var(--text); }
  .data-table tr:last-child td { border-bottom:none; }
  .data-table tr:hover td { background:rgba(243,244,246,.7); }

  /* BADGE */
  .badge { display:inline-flex; align-items:center; padding:2px 9px; border-radius:20px; font-size:.68rem; font-weight:600; }
  .badge-red    { background:rgba(239,68,68,.1);   color:var(--red);    border:1px solid rgba(239,68,68,.2);   }
  .badge-green  { background:rgba(16,185,129,.1);  color:var(--green);  border:1px solid rgba(16,185,129,.2);  }
  .badge-yellow { background:rgba(245,158,11,.1);  color:var(--yellow); border:1px solid rgba(245,158,11,.2);  }
  .badge-blue   { background:rgba(59,130,246,.1);  color:var(--blue);   border:1px solid rgba(59,130,246,.2);  }
  .badge-orange { background:rgba(255,107,26,.1);  color:var(--orange); border:1px solid rgba(255,107,26,.2);  }

  /* PROGRESS BAR */
  .progress-wrap { background:var(--bg); border-radius:99px; height:8px; overflow:hidden; margin-top:.4rem; }
  .progress-bar  { height:100%; border-radius:99px; transition:width .6s; }

  /* BARRA DE ATUALIZAÇÃO */
  .update-info { font-size:.68rem; color:var(--muted); font-family:var(--mono); }

  /* LOADING */
  #loadingScreen { position:fixed; inset:0; background:var(--white); display:flex; align-items:center; justify-content:center; z-index:999; flex-direction:column; gap:1rem; }
  #loadingScreen img { height:44px; object-fit:contain; }
  .spinner { width:28px; height:28px; border:3px solid var(--border); border-top-color:var(--orange); border-radius:50%; animation:spin .7s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }

  /* RESPONSIVE */
  @media(max-width:900px) { .cards-4,.cards-3 { grid-template-columns:repeat(2,1fr); } }
  @media(max-width:600px) { .cards-4,.cards-3,.cards-2 { grid-template-columns:1fr; } .main { padding:1rem; } }
`;
