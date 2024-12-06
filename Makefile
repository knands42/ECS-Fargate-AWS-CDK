REGION := us-east-1
ACCOUNT_ID := $(shell aws sts get-caller-identity --query "Account" --output text)

.PHONY: destroy
destroy:
	cdk destroy --all --require-approval never

.PHONY: deploy
deploy:
	cdk deploy --all --require-approval never

.PHONY: push-to-ecr
push-to-ecr:
	aws ecr get-login-password --region  $(REGION) | docker login --username AWS --password-stdin $(ACCOUNT_ID).dkr.ecr.$(REGION).amazonaws.com

	docker build --platform linux/arm64 -t my-repo .
	docker tag my-repo:latest $(ACCOUNT_ID).dkr.ecr.$(REGION).amazonaws.com/my-repo:latest
	docker push $(ACCOUNT_ID).dkr.ecr.$(REGION).amazonaws.com/my-repo:latest

run-image:
	docker run -p 8080:8080 $(ACCOUNT_ID).dkr.ecr.$(REGION).amazonaws.com/my-repo