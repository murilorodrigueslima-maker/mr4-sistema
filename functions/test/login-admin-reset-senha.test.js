'use strict';
// Esqueci a senha (login.html) e redefinição por e-mail no admin (admin.html): garantias estáticas.
const fs = require('fs'), path = require('path');
const raiz = path.join(__dirname, '..', '..');
const login = fs.readFileSync(path.join(raiz, 'login.html'), 'utf8');
const admin = fs.readFileSync(path.join(raiz, 'modulos', 'admin.html'), 'utf8');

describe('login.html — Esqueci a senha', () => {
  test('botão, função e import do Firebase presentes', () => {
    expect(login).toMatch(/id="btnEsqueci"[^>]*onclick="esqueciSenha\(\)"/);
    expect(login).toMatch(/import \{[^}]*sendPasswordResetEmail[^}]*\} from 'https:\/\/www\.gstatic\.com/);
    expect(login).toMatch(/window\.esqueciSenha = async function/);
  });
  test('resposta neutra: não revela se o e-mail existe e nunca cita user-not-found', () => {
    const f = login.slice(login.indexOf('window.esqueciSenha'), login.indexOf('window.toggleSenha'));
    expect(f).not.toMatch(/user-not-found/);
    expect(f).toMatch(/Se o e-mail estiver cadastrado/);
  });
  test('Enter no botão não dispara o login; login original intacto', () => {
    expect(login).toMatch(/activeElement\?\.id !== 'btnEsqueci'/);
    expect(login).toMatch(/signInWithEmailAndPassword\(auth, email, senha\)/);
  });
});

describe('admin.html — redefinição de senha na edição', () => {
  test('edição esconde o campo de senha (que não fazia nada) e mostra o botão', () => {
    const ed = admin.slice(admin.indexOf('window.abrirModalEditar'), admin.indexOf('window.abrirModalEditar') + 1500);
    expect(ed).toMatch(/senhaGroup'\)\.style\.display = 'none'/);
    expect(ed).toMatch(/resetGroup'\)\.style\.display = ''/);
  });
  test('novo usuário mantém a senha inicial; perfil existente não mostra o botão', () => {
    const nv = admin.slice(admin.indexOf('window.abrirModalNovo'), admin.indexOf('window.abrirModalEditar'));
    expect(nv).toMatch(/senhaGroup'\)\.style\.display = ''/);
    expect(nv).toMatch(/resetGroup'\)\.style\.display = 'none'/);
    const pf = admin.slice(admin.indexOf('window.abrirModalPerfil'), admin.indexOf('window.abrirModalPerfil') + 1200);
    expect(pf).toMatch(/resetGroup'\)\.style\.display = 'none'/);
  });
  test('enviarResetUsuario usa só sendPasswordReset (nenhuma senha trafega pelo sistema)', () => {
    const f = admin.slice(admin.indexOf('window.enviarResetUsuario'), admin.indexOf('Modal de exclusão'));
    expect(f).toMatch(/window\._sendPasswordReset\(email\)/);
    expect(f).not.toMatch(/fSenha|updatePassword/);
  });
  test('criação de usuário continua criando a conta com a senha informada', () => {
    expect(admin).toMatch(/window\._createUser\(email, senha\)/);
  });
});
