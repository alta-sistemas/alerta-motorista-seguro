# TODO — Alerta

## Entregáveis

- [x] **Modo Motorista discreto**
  - O app oferece uma alternância explícita entre Motorista e Segurança.
  - No modo Motorista, o botão exige pressão contínua de 1,4 s.
  - O acionamento aparece como um pequeno botão flutuante no canto inferior, sem o texto visível de pânico.
  - O acionamento não abre SMS, compartilhamento, discador ou tela chamativa.
  - O app informa discretamente quando está conectando, enviando ou sem conexão.

- [x] **Perfil do motorista e veículo**
  - O motorista pode cadastrar, editar e limpar até três contatos.
  - Cada contato tem nome e telefone validados.
  - O motorista informa modelo, cor e placa do carro.
  - Perfil e última localização ficam salvos localmente no aparelho.

- [x] **Pareamento com a central**
  - O modo Segurança gera um código de seis dígitos.
  - O motorista informa esse código para vincular o aparelho à central.
  - O backend registra os dispositivos e o vínculo entre motorista e central.

- [x] **Alerta HTTPS sem SMS**
  - O acionamento envia ao backend o identificador do motorista, horário, localização atual ou última localização e dados do veículo.
  - A localização atual tem timeout de 9 s e o fallback é identificado como última localização.
  - O app informa quando o alerta foi entregue a uma central ou quando nenhuma central está pareada.
  - O app não promete contato automático com a polícia; mantém a orientação para ligar 190 em risco imediato.

- [x] **Modo Segurança**
  - A central exibe o código de pareamento e mantém uma inbox de emergência.
  - A inbox consulta novos alertas periodicamente.
  - Um novo alerta gera notificação local no Android quando as permissões estão ativas.
  - Cada alerta mostra motorista, horário, veículo, localização e ações para abrir o mapa e assumir o alerta.

- [x] **Preparação de notificações em segundo plano**
  - A central solicita permissão, cria o canal de emergência e registra o ExpoPushToken quando há projectId Expo/EAS.
  - O backend envia uma notificação remota aos tokens das centrais pareadas no momento do alerta.
  - O fallback continua sendo a inbox por polling quando o app está aberto.

- [x] **Backend e qualidade**
  - A raiz da API responde com health check em vez de `Cannot GET /`.
  - TypeScript, lint, build, testes existentes e exportação do bundle Android passaram.
  - O app mantém Expo/React Native/TypeScript e os identificadores nativos do projeto.

## Validação pendente

- [ ] Gerar e instalar um novo APK a partir do checkpoint atual e testar em dois aparelhos Android: um em modo Motorista e outro em modo Segurança.
- [ ] Configurar projectId Expo/EAS e credenciais FCM, gerar um build Android real e confirmar push com o app da central fechado.
- [ ] Implementar e testar o serviço nativo Android que mantém o botão sobre outros apps; `SYSTEM_ALERT_WINDOW` já está declarado e o app abre a tela de autorização.
- [ ] Confirmar no aparelho real a permissão de localização, a notificação local da central, o pareamento e a entrega do alerta com a tela do motorista permanecendo discreta.
- [ ] A primeira versão usa polling da central e armazenamento em memória do backend; para produção, migrar dispositivos, vínculos e alertas para o banco gerenciado e usar push remoto com autenticação forte.
