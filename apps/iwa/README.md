# IWA

Esta pasta contém a IWA atual: engine patched, glue correspondente, metadata e
todos os assets da versão `version-f807b21caba84809-RobloxWebClient`.

O fallback web compartilha estes mesmos arquivos. O servidor entrega os arquivos
específicos de `apps/site/` primeiro e, para `/engine/*` e o restante compartilhado,
usa esta árvore. Assim não existem duas cópias do engine para divergir.

O artefato `.swbn` já gerado continua em `C:\Users\lucas\weblox-ext\build\weblox.swbn`
na máquina local. Ele é intencionalmente excluído do repositório por ser um
artefato grande e assinado; a chave privada não deve ser enviada ao GitHub.
