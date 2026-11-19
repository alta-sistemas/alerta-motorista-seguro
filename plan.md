# Plano — Alerta

## Escopo

Construir um aplicativo Android discreto para motoristas de aplicativo e pessoas de segurança. O motorista cadastra até três contatos de emergência, informa os dados do veículo e aciona um pedido de socorro por pressão prolongada. Em vez de abrir SMS, o app envia o alerta por HTTPS ao backend; o aplicativo em modo Segurança recebe o alerta, mostra localização e dados do carro e permite abrir o mapa. O app não promete chamada automática à polícia.

## Implementação

- **Dois modos no mesmo app:** modo Motorista para envio silencioso por rede e modo Segurança para central de recebimento.
- **Atalho flutuante:** no modo Motorista, o acionamento fica como um pequeno controle flutuante no canto inferior, sem texto de pânico; o gesto de pressão longa continua obrigatório.
- **Pareamento:** a central gera um código de seis dígitos; o motorista informa o código para vincular seu aparelho à central.
- **Alerta online:** o backend recebe o identificador do motorista, localização atual ou última localização, horário e dados do veículo. O acionamento não abre SMS nem compartilhamento.
- **Notificação em segundo plano:** a central registra um ExpoPushToken no Android e o backend envia uma notificação remota quando o alerta é criado; isso exige projectId Expo/EAS, credenciais FCM e um build Android real.
- **Overlay Android:** o manifest declara `SYSTEM_ALERT_WINDOW` e o app abre a tela oficial de autorização. O botão realmente persistente sobre outros apps depende de um serviço nativo Android e não pode ser validado no Expo Go/Web Preview.
- **Recebimento:** o modo Segurança consulta a inbox periodicamente, cria uma notificação local quando aparece um novo alerta e apresenta os detalhes com ações de mapa e reconhecimento.
- **Configuração:** o motorista mantém até três contatos, modelo/cor/placa do carro e localização local persistida em AsyncStorage.
- **Localização:** solicitar permissão foreground, tentar a localização atual com timeout de 9 s e usar a última localização salva quando disponível.
- **Privacidade:** a confirmação é discreta, sem sirene ou histórico chamativo no modo Motorista. A central deve permanecer conectada para consultar os alertas nesta primeira versão; o fallback offline é mostrar claramente que o alerta não foi entregue.

## Estrutura

- `app/(tabs)/index.tsx`: alternância Motorista/Segurança, botão de pressão longa, cadastro, pareamento e inbox.
- `lib/panic.ts`: perfil, armazenamento local e localização; não contém mais envio SMS.
- `lib/alert-api.ts`: identidade local, registro, pareamento, envio e consulta de alertas.
- `server/_core/alertApi.ts`: endpoints HTTPS para registrar aparelhos, parear, criar alertas, consultar inbox e reconhecer alertas.
- `server/_core/index.ts`: registro das rotas de alerta e health check.
- `app.config.ts`: permissões, notificações e identificadores nativos preservados.

## Direção visual

Escolha: **Utilitário silencioso / painel de frota**. Base grafite-azulada e superfícies claras mantêm o app neutro; âmbar marca ação operacional sem parecer sirene; verde indica prontidão; vermelho fica reservado ao alerta na central.

A interface usa uma coluna vertical de leitura rápida, alternância explícita de modo, botão circular de pressão longa e cartões de estado. O modo Motorista evita linguagem alarmista e SMS; o modo Segurança dá prioridade visual aos alertas novos, localização e ações de resposta.

A marca permanece sóbria, rápida e confiável: “Ajuda sem abrir mensagens.” para o motorista e “Pedidos de ajuda, em primeiro plano.” para a central.
