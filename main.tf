terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "allowed_cidr" {
  description = "Tu IP pública o red autorizada, por ejemplo 203.0.113.10/32"
  type        = string
}

variable "key_name" {
  description = "Nombre de un key pair SSH existente en AWS"
  type        = string
}

variable "instance_type" {
  type    = string
  default = "t3.large"
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ssm_parameter" "amazon_linux_2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_vpc" "demo" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "demo-vpc" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.demo.id
  cidr_block              = "10.20.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = { Name = "demo-public-subnet" }
}

resource "aws_internet_gateway" "demo" {
  vpc_id = aws_vpc.demo.id
  tags   = { Name = "demo-igw" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.demo.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.demo.id
  }

  tags = { Name = "demo-public-rt" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "demo" {
  name        = "demo-compose-sg"
  description = "Acceso restringido al host de Docker Compose"
  vpc_id      = aws_vpc.demo.id

  dynamic "ingress" {
    for_each = {
      ssh     = 22
      api     = 8000
      grafana = 3000
    }

    content {
      description = ingress.key
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = [var.allowed_cidr]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "demo-compose-sg" }
}

resource "aws_instance" "compose_host" {
  ami                         = data.aws_ssm_parameter.amazon_linux_2023.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.demo.id]
  key_name                    = var.key_name
  associate_public_ip_address = true

  root_block_device {
    encrypted   = true
    volume_size = 40
    volume_type = "gp3"
  }

  tags = { Name = "demo-compose-host" }
}

output "public_ip" {
  value = aws_instance.compose_host.public_ip
}

output "api_url" {
  value = "http://${aws_instance.compose_host.public_ip}:8000"
}

output "grafana_url" {
  value = "http://${aws_instance.compose_host.public_ip}:3000"
}