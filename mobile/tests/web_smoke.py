# Smoke test funcional — MAK Frotas mobile (build web via react-native-web)
# Valida: render do login, integracao com API de producao (erro 401 exibido),
# navegacao para Solicitar Cadastro e validacao de formulario.
import sys
from playwright.sync_api import sync_playwright

# Porta 3000: presente na whitelist de CORS do backend de producao
URL = "http://localhost:3000"
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS" if ok else "FAIL") + f" - {name}" + (f" ({detail})" if detail else ""))


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 412, "height": 915})  # tela de celular
    page.goto(URL, timeout=120000)
    page.wait_for_load_state("networkidle", timeout=120000)
    # Expo web: primeiro acesso compila o bundle — espera o texto da marca
    page.wait_for_selector("text=MAK FROTAS", timeout=180000)

    # 1. Login renderiza
    check("login: marca visivel", page.locator("text=MAK FROTAS").count() > 0)
    check("login: botao Entrar", page.locator("text=Entrar").count() > 0)
    check("login: link solicitar cadastro", page.locator("text=Solicitar cadastro").count() > 0)
    page.screenshot(path="tests/out_login.png")

    # 2. Validacao local: campos vazios
    page.locator("text=Entrar").first.click()
    page.wait_for_timeout(500)
    check("login: valida campos vazios", page.locator("text=Informe usuário e senha").count() > 0)

    # 3. Integracao API producao: credencial invalida -> 401 -> mensagem
    inputs = page.locator("input")
    inputs.nth(0).fill("teste.smoke.invalido")
    inputs.nth(1).fill("senha-errada-123")
    page.locator("text=Entrar").first.click()
    try:
        page.wait_for_selector("text=/Credenciais inválidas/i", timeout=30000)
        check("login: erro 401 da API de producao exibido", True)
    except Exception:
        page.screenshot(path="tests/out_login_error.png")
        check("login: erro 401 da API de producao exibido", False, "mensagem nao apareceu")

    # 4. Navegacao: Solicitar cadastro
    page.locator("text=Solicitar cadastro").first.click()
    page.wait_for_timeout(1500)
    ok_nav = page.locator("text=Enviar solicitação").count() > 0
    check("cadastro: tela abre com formulario", ok_nav)
    page.screenshot(path="tests/out_cadastro.png")

    if ok_nav:
        # 5. Validacao local do formulario de cadastro (nao envia nada a producao)
        page.locator("text=Enviar solicitação").first.click()
        page.wait_for_timeout(500)
        check(
            "cadastro: valida campos obrigatorios",
            page.locator("text=Todos os campos são obrigatórios").count() > 0,
        )

    browser.close()

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} testes passaram")
sys.exit(1 if failed else 0)
